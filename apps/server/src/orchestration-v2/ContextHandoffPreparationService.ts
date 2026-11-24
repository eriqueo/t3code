import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type { OrchestratorV2Error } from "./Orchestrator.ts";

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

  // Preparation is retired. A request persisted before the upgrade settles as a visible
  // failure without selecting transcript passages, so no thread stays "preparing".
  const execute: ContextHandoffPreparationService["Service"]["execute"] = Effect.fn(
    "ContextHandoffPreparationService.execute",
  )(function* (input) {
    const projection = yield* threads.getThreadRecords(input.threadId, []);
    const current = projection.thread.compactHandoff;
    if (current?.state !== "requested" || current.requestId !== input.requestId) return;
    yield* threads.dispatch({
      type: "thread.handoff.complete",
      commandId: CommandId.make(`${input.requestId}:handoff-complete`),
      threadId: input.threadId,
      payload: {
        state: "failed",
        requestId: input.requestId,
        sourceMessageId: input.sourceMessageId,
        code: "retired",
        detail: "Start fresh's transcript handoff is retired; start a new thread.",
      },
    });
  });
  return ContextHandoffPreparationService.of({ execute });
});

export const layer = Layer.effect(ContextHandoffPreparationService, make);
