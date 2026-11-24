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
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
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
      Layer.mock(ProcessRunner.ProcessRunner)({
        run: (input) => Effect.die(`Retired preparation launched ${input.command}`),
      }),
    ),
  ),
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
    ],
  });
  return threads;
});

it.effect("refuses preparation and start from a client that predates the retirement", () =>
  Effect.gen(function* () {
    const threads = yield* seed;
    const targetThreadId = ThreadId.make("compact-successor");
    for (const command of [
      {
        type: "thread.handoff.prepare" as const,
        commandId: requestId,
        threadId,
        sourceMessageId,
      },
      {
        type: "thread.handoff.start" as const,
        commandId: CommandId.make("compact-start"),
        threadId,
        requestId,
        targetThreadId,
        createdBy: "user" as const,
        creationSource: "web" as const,
      },
    ]) {
      const result = yield* Effect.flip(threads.dispatch(command));
      assert.equal(result._tag, "OrchestratorContextHandoffRetiredError");
      assert.equal(
        result.message,
        "Start fresh's transcript handoff is retired; start a new thread.",
      );
    }
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    assert.lengthOf(yield* outbox.listByCommandId(requestId), 0);
    const source = yield* threads.getThreadProjection(threadId);
    assert.isUndefined(source.thread.compactHandoff);
    assert.isNull(source.thread.archivedAt);
    assert.equal(
      (yield* Effect.result(threads.getThreadProjection(targetThreadId)))._tag,
      "Failure",
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("settles a preparation persisted before the upgrade without selecting passages", () =>
  Effect.gen(function* () {
    const threads = yield* seed;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const { thread } = yield* threads.getThreadProjection(threadId);
    yield* sink.write({
      events: [
        {
          id: EventId.make("compact-requested-event"),
          type: "thread.metadata-updated",
          threadId,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: now,
          payload: {
            ...thread,
            compactHandoff: { state: "requested", requestId, sourceMessageId },
            updatedAt: now,
          },
        },
      ],
    });
    const execute = Preparation.ContextHandoffPreparationService.use((service) =>
      service.execute({ threadId, requestId, sourceMessageId, attemptCount: 1 }),
    );
    yield* execute;
    // A reclaimed outbox attempt replays the same effect; it must settle, not loop.
    yield* execute;
    const settled = (yield* threads.getThreadProjection(threadId)).thread.compactHandoff;
    assert.equal(settled?.state, "failed");
    if (settled?.state === "failed") assert.equal(settled.code, "retired");

    // An older client can still clear the banner it shows for that failure.
    yield* threads.dispatch({
      type: "thread.handoff.dismiss",
      commandId: CommandId.make("compact-dismiss"),
      threadId,
      sourceMessageId,
    });
    assert.equal(
      (yield* threads.getThreadProjection(threadId)).thread.compactHandoff?.state,
      "dismissed",
    );
  }).pipe(Effect.provide(testLayer)),
);
