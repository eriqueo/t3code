import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { formatContextCheckpoint } from "@t3tools/shared/contextHandoff";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as EventSink from "./EventSink.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Preparation from "./ContextHandoffPreparationService.ts";

const threadId = ThreadId.make("compact-source");
const sourceMessageId = MessageId.make("compact-user");
const requestId = CommandId.make("compact-request");
const projectId = ProjectId.make("compact-project");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Native execution is disabled in compact handoff tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const database = SqlitePersistence.layerMemory;
const orchestrator = ProviderReplayHarness.layerWithRegistry(
  { name: "compact-handoff" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { databaseLayer: database, runEffectWorker: false },
);
const threadsLayer = ThreadManagement.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      orchestrator,
      ServerSettings.layerTest(),
      CommandReceiptStore.layer.pipe(Layer.provide(database)),
    ),
  ),
);
const preparationLayer = Preparation.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      threadsLayer,
      database,
      Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeed(Option.none()) }),
      Layer.mock(ProcessRunner.ProcessRunner)({
        run: (input) =>
          input.command === "t3-dx2-handoff"
            ? Effect.die("An explicit checkpoint must never launch DX2")
            : Effect.succeed({
                stdout: "",
                stderr: "",
                code: ChildProcessSpawner.ExitCode(1),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              }),
      }),
    ),
  ),
  Layer.provide(NodeServices.layer),
);
const testLayer = Layer.mergeAll(
  orchestrator,
  threadsLayer,
  preparationLayer,
  database,
  EffectOutbox.layer.pipe(Layer.provide(database)),
);

const seed = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const later = DateTime.add(now, { seconds: 1 });
  yield* threads.dispatch({
    type: "thread.create",
    commandId: CommandId.make("compact-create"),
    threadId,
    projectId,
    title: "Keep all features",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: "/fixture/missing-checkout",
    createdBy: "user",
    creationSource: "web",
  });
  yield* sink.write({
    events: [
      {
        id: EventId.make("compact-user-event"),
        type: "message.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: sourceMessageId,
          threadId,
          runId: null,
          nodeId: null,
          role: "user",
          text: "Preserve all features",
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
          createdBy: "user",
          creationSource: "web",
        },
      },
      {
        id: EventId.make("compact-checkpoint-event"),
        type: "message.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: MessageId.make("compact-checkpoint"),
          threadId,
          runId: null,
          nodeId: null,
          role: "assistant",
          text: formatContextCheckpoint("Keep the exact handoff. No deployment yet."),
          attachments: [],
          streaming: false,
          createdAt: later,
          updatedAt: later,
          createdBy: "agent",
          creationSource: "provider",
        },
      },
    ],
  });
  return threads;
});
const request = {
  type: "thread.handoff.prepare" as const,
  commandId: requestId,
  threadId,
  sourceMessageId,
};
const execute = (attemptCount = 1) =>
  Preparation.ContextHandoffPreparationService.use((service) =>
    service.execute({ threadId, requestId, sourceMessageId, attemptCount }),
  );

it.effect("retains the exact checkpoint and atomically starts one fresh thread on replay", () =>
  Effect.gen(function* () {
    const threads = yield* seed;
    yield* threads.dispatch(request);
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const queued = yield* outbox.listByCommandId(requestId);
    assert.equal(
      queued.filter((effect) => effect.request.type === "thread.handoff.prepare").length,
      1,
    );
    yield* threads.dispatch(request);
    yield* execute();
    const ready = (yield* threads.getThreadProjection(threadId)).thread.compactHandoff;
    assert.equal(ready?.state, "ready");
    if (ready?.state !== "ready") return yield* Effect.die("Expected ready checkpoint");
    assert.equal(ready.handoff, "Keep the exact handoff. No deployment yet.");
    assert.equal(ready.inputCharacters, 0);
    assert.isDefined(ready.workspaceObservation);
    assert.isDefined(ready.testEvidence);
    assert.isDefined(ready.runtimeObservation);
    const targetThreadId = ThreadId.make("compact-successor");
    const start = {
      type: "thread.handoff.start" as const,
      commandId: CommandId.make("compact-start"),
      threadId,
      requestId,
      targetThreadId,
      createdBy: "user" as const,
      creationSource: "web" as const,
    };
    const first = yield* threads.dispatch(start);
    const replayed = yield* threads.dispatch(start);
    assert.equal(replayed.sequence, first.sequence);
    const source = yield* threads.getThreadProjection(threadId);
    const target = yield* threads.getThreadProjection(targetThreadId);
    assert.isNotNull(source.thread.archivedAt);
    assert.equal(source.thread.compactHandoff?.state, "started");
    assert.equal(target.thread.worktreePath, source.thread.worktreePath);
    assert.deepEqual(target.thread.modelSelection, source.thread.modelSelection);
    assert.lengthOf(target.messages, 1);
    assert.include(target.messages[0]!.text, ready.handoff);
    assert.include(target.messages[0]!.text, "T3 historical test receipts");
    assert.lengthOf(target.runs, 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("makes a reclaimed worker terminal without a second selection", () =>
  Effect.gen(function* () {
    const threads = yield* seed;
    yield* threads.dispatch(request);
    yield* execute(2);
    const state = (yield* threads.getThreadProjection(threadId)).thread.compactHandoff;
    assert.equal(state?.state, "failed");
    if (state?.state === "failed") assert.equal(state.code, "worker_interrupted");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("does not publish a dismissed result or start a stale continuation", () =>
  Effect.gen(function* () {
    const threads = yield* seed;
    yield* threads.dispatch(request);
    yield* threads.dispatch({
      type: "thread.handoff.dismiss",
      commandId: CommandId.make("compact-dismiss"),
      threadId,
      sourceMessageId,
    });
    yield* execute();
    assert.equal(
      (yield* threads.getThreadProjection(threadId)).thread.compactHandoff?.state,
      "dismissed",
    );
    const result = yield* Effect.result(
      threads.dispatch({
        type: "thread.handoff.start",
        commandId: CommandId.make("compact-stale-start"),
        threadId,
        requestId,
        targetThreadId: ThreadId.make("compact-stale-target"),
        createdBy: "user",
        creationSource: "web",
      }),
    );
    assert.equal(result._tag, "Failure");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects a ready handoff after a newer user message without archiving its source", () =>
  Effect.gen(function* () {
    const threads = yield* seed;
    yield* threads.dispatch(request);
    yield* execute();
    const sink = yield* EventSink.EventSinkV2;
    const now = DateTime.add(yield* DateTime.now, { seconds: 2 });
    yield* sink.write({
      events: [
        {
          id: EventId.make("compact-new-user-event"),
          type: "message.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: MessageId.make("compact-new-user"),
            threadId,
            runId: null,
            nodeId: null,
            role: "user",
            text: "A newer decision",
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
            createdBy: "user",
            creationSource: "web",
          },
        },
      ],
    });
    const result = yield* Effect.result(
      threads.dispatch({
        type: "thread.handoff.start",
        commandId: CommandId.make("compact-outdated-start"),
        threadId,
        requestId,
        targetThreadId: ThreadId.make("compact-outdated-target"),
        createdBy: "user",
        creationSource: "web",
      }),
    );
    assert.equal(result._tag, "Failure");
    assert.isNull((yield* threads.getThreadProjection(threadId)).thread.archivedAt);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects preparation while a user message is queued", () =>
  Effect.gen(function* () {
    const threads = yield* seed;
    const messageId = MessageId.make("compact-queued-user");
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("compact-queue"),
      threadId,
      messageId,
      text: "Wait for this",
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    const result = yield* Effect.result(
      threads.dispatch({ ...request, sourceMessageId: messageId }),
    );
    assert.equal(result._tag, "Failure");
    assert.isUndefined((yield* threads.getThreadProjection(threadId)).thread.compactHandoff);
  }).pipe(Effect.provide(testLayer)),
);
