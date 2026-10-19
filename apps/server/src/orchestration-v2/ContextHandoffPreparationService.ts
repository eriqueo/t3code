import {
  CommandId,
  MessageId,
  ThreadId,
  type ThreadHandoffReadyActivityPayload,
  type ThreadHandoffFailedActivityPayload,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type { OrchestratorV2Error } from "./Orchestrator.ts";
import * as ProcessRunner from "../processRunner.ts";
import { prepareContextHandoff } from "./contextHandoffWorker.ts";
import { makeHandoffWorkspaceObserver } from "../workspace/HandoffWorkspace.ts";
import { makeHandoffTestCollector } from "../workspace/TestRunReceipts.ts";
import { makeHandoffRuntimeObserver } from "../workspace/HandoffRuntime.ts";

export class ContextHandoffPreparationService extends Context.Service<
  ContextHandoffPreparationService,
  {
    readonly execute: (input: {
      readonly threadId: ThreadId;
      readonly requestId: CommandId;
      readonly sourceMessageId: MessageId;
      readonly attemptCount: number;
    }) => Effect.Effect<
      void,
      | OrchestratorV2Error
      | ProjectStore.ProjectStoreV2Error
      | ThreadManagementService.ThreadManagementProviderInstanceDisabledError
    >;
  }
>()("t3/orchestration-v2/ContextHandoffPreparationService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const runner = yield* ProcessRunner.ProcessRunner;
  const observeWorkspace = yield* makeHandoffWorkspaceObserver;
  const collectTests = yield* makeHandoffTestCollector;
  const observeRuntime = yield* makeHandoffRuntimeObserver;

  const execute: ContextHandoffPreparationService["Service"]["execute"] = Effect.fn(
    "ContextHandoffPreparationService.execute",
  )(function* (input) {
    const projection = yield* threads.getThreadRecords(input.threadId, ["messages"]);
    const current = projection.thread.compactHandoff;
    if (
      current?.state !== "requested" ||
      current.requestId !== input.requestId ||
      current.sourceMessageId !== input.sourceMessageId ||
      projection.messages.findLast((message) => message.role === "user" && !message.streaming)
        ?.id !== input.sourceMessageId ||
      projection.thread.archivedAt !== null ||
      projection.thread.deletedAt !== null
    )
      return;

    const failed = (code: string, detail: string): ThreadHandoffFailedActivityPayload => ({
      state: "failed",
      requestId: input.requestId,
      sourceMessageId: input.sourceMessageId,
      code,
      detail,
    });
    let payload: ThreadHandoffReadyActivityPayload | ThreadHandoffFailedActivityPayload;
    if (input.attemptCount > 1) {
      // Non-retriable external selection: a reclaimed outbox attempt reaches a
      // visible terminal state without launching a second DX2 process.
      payload = failed(
        "worker_interrupted",
        "Handoff preparation was interrupted. Prepare a new handoff to try again.",
      );
    } else {
      const project = yield* projects.get(projection.thread.projectId);
      const cwd = projection.thread.worktreePath ?? Option.getOrUndefined(project)?.workspaceRoot;
      if (!cwd) {
        payload = failed("workspace_missing", "The thread has no available workspace.");
      } else {
        const result = yield* Effect.result(
          prepareContextHandoff({
            cwd,
            title: projection.thread.title,
            messages: projection.messages,
          }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, runner)),
        );
        if (Result.isFailure(result)) {
          payload = failed(result.failure.code, result.failure.detail);
        } else {
          const workspaceObservation = yield* observeWorkspace(cwd);
          const testEvidence = yield* collectTests(
            input.threadId,
            workspaceObservation.state === "observed" ? workspaceObservation.cwd : null,
          );
          const runtimeObservation = yield* observeRuntime();
          payload = {
            state: "ready",
            requestId: input.requestId,
            sourceMessageId: input.sourceMessageId,
            ...result.success,
            workspaceObservation,
            testEvidence,
            runtimeObservation,
          };
        }
      }
    }
    yield* threads.dispatch({
      type: "thread.handoff.complete",
      commandId: CommandId.make(`${input.requestId}:handoff-complete`),
      threadId: input.threadId,
      payload,
    });
  });
  return ContextHandoffPreparationService.of({ execute });
});

export const layer = Layer.effect(ContextHandoffPreparationService, make);
