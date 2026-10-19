import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CodexSettings,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  REVIEW_PROVIDER_INSTANCE_ID,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { buildCodexInitializeParams } from "./CodexProvider.ts";
import { CodexReviewLaunchConfig } from "./codexReviewPolicy.ts";
import { makeReviewClientFactory } from "./CodexReviewRuntime.ts";

// Opt-in local acceptance: startup paths only, never a credential value. This
// creates no model turn and never uses the live T3 database or a project cwd.
const launchJson = process.env.HWC_REVIEW_NATIVE_TEST_SPEC;
const decodeLaunch = Schema.decodeUnknownEffect(Schema.fromJsonString(CodexReviewLaunchConfig));
const decodeSettings = Schema.decodeEffect(CodexSettings);
it.live.skipIf(launchJson === undefined)(
  "opens the pinned native in a private namespace and removes its owned scope",
  () =>
    Effect.gen(function* () {
      if (launchJson === undefined) return yield* Effect.die("Missing native acceptance spec");
      const launch = yield* decodeLaunch(launchJson);
      const factory = yield* makeReviewClientFactory(launch);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      let temporaryRoot = "";
      yield* Effect.scoped(
        Effect.gen(function* () {
          const client = yield* factory.open({
            instanceId: ProviderInstanceId.make(REVIEW_PROVIDER_INSTANCE_ID),
            threadId: ThreadId.make("isolated-review-native-acceptance"),
            providerSessionId: ProviderSessionId.make("isolated-review-native-acceptance"),
            runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
            settings: yield* decodeSettings({}),
            environment: {},
          });
          yield* client.request("initialize", buildCodexInitializeParams());
          yield* client.notify("initialized", undefined);
          const response = yield* client.request("thread/start", { model: "gpt-6.1-sol" });
          assert.isTrue(response.cwd.endsWith("/private/neutral"));
          const snapshot = yield* client.request("thread/read", {
            threadId: response.thread.id,
            includeTurns: false,
          });
          assert.equal(snapshot.thread.id, response.thread.id);
          temporaryRoot = path.dirname(path.dirname(response.cwd));
          // The credential lives in the namespace's tmpfs, not the backing folder.
          assert.isFalse(
            yield* fs.exists(path.join(temporaryRoot, "private/home/codex/auth.json")),
          );
          const denied = yield* Effect.result(
            client.raw.request("command/exec", { command: ["true"] }),
          );
          assert.equal(denied._tag, "Failure");
        }),
      );
      assert.isFalse(yield* fs.exists(temporaryRoot));
    }).pipe(Effect.provide(NodeServices.layer), Effect.timeout("45 seconds")),
);
