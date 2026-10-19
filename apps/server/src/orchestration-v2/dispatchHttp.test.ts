import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthOrchestrationOperateScope,
  CommandId,
  MessageId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  EnvironmentHttpApi,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentAuthInvalidError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpApiTest } from "effect/http-api";
import { HttpServer, HttpServerRequest } from "effect/http";
import * as DispatchHttp from "./dispatchHttp.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Startup from "../serverRuntimeStartup.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} from "@t3tools/contracts";
const protocolHeaders = {
  [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} as const;

const auth = Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!request.headers.authorization)
      return yield* new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "missing_credential",
        traceId: "test",
      });
    return yield* effect.pipe(
      Effect.provideService(EnvironmentAuthenticatedPrincipal, {
        sessionId: AuthSessionId.make("dispatch-test"),
        subject: "test",
        method: "bearer-access-token",
        scopes: new Set(
          request.headers.authorization === "Bearer operate" ? [AuthOrchestrationOperateScope] : [],
        ),
      }),
    );
  }),
);
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("HTTP acceptance must not launch an agent"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const runtime = ProviderReplayHarness.layerWithRegistry(
  { name: "http-dispatch" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { databaseLayer: database, runEffectWorker: false },
);
const threads = ThreadManagement.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      runtime,
      CommandReceiptStore.layer.pipe(Layer.provide(database)),
      ServerSettings.layerTest(),
    ),
  ),
);
const startup = Layer.effect(
  Startup.ServerRuntimeStartup,
  Effect.gen(function* () {
    const gate = yield* Startup.makeCommandGate;
    yield* gate.signalCommandReady;
    return {
      awaitCommandReady: gate.awaitCommandReady,
      enqueueCommand: gate.enqueueCommand,
      markHttpListening: Effect.void,
    };
  }),
);
const services = Layer.mergeAll(
  threads,
  ServerSettings.layerTest(),
  startup,
  Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
  ServerConfig.layerTest(process.cwd(), { prefix: "dispatch-http-" }),
).pipe(Layer.provideMerge(NodeServices.layer));
const routes = DispatchHttp.layer.pipe(Layer.provideMerge(services), Layer.provideMerge(auth));

it.effect(
  "authorizes HTTP dispatch and deduplicates a deferred message through real command receipts",
  () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(EnvironmentHttpApi, ["orchestrationDispatch"]);
      const threadId = ThreadId.make("http-dispatch-thread");
      const create = {
        type: "thread.create" as const,
        commandId: CommandId.make("http-create"),
        threadId,
        projectId: ProjectId.make("http-project"),
        title: "HTTP acceptance",
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        createdBy: "user" as const,
        creationSource: "server" as const,
      };
      assert.equal(
        (yield* Effect.result(
          client.orchestrationDispatch.dispatch({ headers: protocolHeaders, payload: create }),
        ))._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.result(
          client.orchestrationDispatch.dispatch({
            headers: { ...protocolHeaders, authorization: "Bearer read" },
            payload: create,
          }),
        ))._tag,
        "Failure",
      );
      const headers = { ...protocolHeaders, authorization: "Bearer operate" };
      yield* client.orchestrationDispatch.dispatch({ headers, payload: create });
      const payload = {
        type: "message.dispatch" as const,
        commandId: CommandId.make("http-message"),
        threadId,
        messageId: MessageId.make("http-message"),
        text: "Queue this disposable test only",
        attachments: [],
        dispatchMode: { type: "defer_start" as const },
        createdBy: "user" as const,
        creationSource: "server" as const,
      };
      const first = yield* client.orchestrationDispatch.dispatch({ headers, payload });
      const replay = yield* client.orchestrationDispatch.dispatch({ headers, payload });
      assert.equal(replay.sequence, first.sequence);
      const management = yield* ThreadManagement.ThreadManagementService;
      const projection = yield* management.getThreadProjection(threadId);
      assert.lengthOf(projection.messages, 1);
      assert.lengthOf(projection.runs, 1);
      assert.equal(projection.runs[0]?.status, "preparing");
    }).pipe(Effect.provide(Layer.mergeAll(routes, HttpServer.layerServices))),
);
