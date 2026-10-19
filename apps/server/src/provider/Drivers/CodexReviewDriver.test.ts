import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, REVIEW_PROVIDER_INSTANCE_ID } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../../config.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { makeCodexReviewDriver } from "./CodexReviewDriver.ts";

const driver = makeCodexReviewDriver({
  nativeDirectory: "/nix/store/00000000000000000000000000000000-native-fixture",
  pythonPath: "/fixture/python",
  mountPath: "/fixture/mount",
  unsharePath: "/fixture/unshare",
  authSource: "/fixture/account.json",
  path: "/fixture/bin",
});
const input = {
  instanceId: ProviderInstanceId.make(REVIEW_PROVIDER_INSTANCE_ID),
  displayName: "Untrusted name",
  environment: [],
  enabled: true,
  config: {},
};
const runtime = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "review-driver-" }),
).pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(NodeCrypto.layer));

it.effect(
  "discovers only the fixed Review model without opening native resources or exposing maintenance",
  () =>
    Effect.gen(function* () {
      // The deliberately absent native paths make an accidental launch fail.
      const instance = yield* driver.create(input);
      const snapshot = yield* instance.snapshot.getSnapshot;
      assert.equal(instance.displayName, "Review");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["gpt-6.1-sol"],
      );
      assert.equal(snapshot.instanceId, input.instanceId);
      assert.equal(snapshot.supportsConversationRollback, false);
      assert.deepEqual(yield* instance.snapshot.refresh, snapshot);
      assert.deepEqual(yield* Stream.runCollect(instance.snapshot.streamChanges), []);
      assert.equal((yield* instance.snapshot.resolveMaintenance()).update, null);
      assert.isUndefined(instance.auth);
      assert.isUndefined(instance.consumeResetCredit);
      assert.isUndefined(instance.refreshModels);
      const capabilities = yield* instance.orchestrationAdapter.getCapabilities();
      assert.isFalse(capabilities.sessions.supportsModelSwitchInSession);
      assert.isFalse(capabilities.sessions.supportsMultipleProviderThreadsPerSession);
      assert.isFalse(capabilities.sessions.supportsProviderSwitchingViaHandoff);
      assert.isFalse(capabilities.checkpointing.appCanCheckpointFilesystem);
      assert.isFalse(capabilities.threads.canRollbackThread);
      assert.isFalse(capabilities.threads.canForkThread);
      assert.isFalse(capabilities.tools.supportsMcpTools);
      assert.isFalse(capabilities.tools.supportsDynamicToolCallbacks);
    }).pipe(Effect.provide(runtime)),
);

it.effect.each([
  { instanceId: ProviderInstanceId.make("codex_personal") },
  { enabled: false },
  { environment: [{ name: "CODEX_HOME", value: "/untrusted", sensitive: false }] },
])("refuses caller-controlled identity or environment: %j", (change) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(driver.create({ ...input, ...change }));
    assert.equal(result._tag, "Failure");
  }).pipe(Effect.provide(runtime)),
);

it.effect("rejects background title generation without opening the runtime", () =>
  Effect.gen(function* () {
    const instance = yield* driver.create(input);
    const result = yield* Effect.result(
      instance.textGeneration.generateThreadTitle({
        cwd: "/fixture/project",
        message: "Review",
        modelSelection: { instanceId: input.instanceId, model: "gpt-6.1-sol" },
      }),
    );
    assert.equal(result._tag, "Failure");
  }).pipe(Effect.provide(runtime)),
);
