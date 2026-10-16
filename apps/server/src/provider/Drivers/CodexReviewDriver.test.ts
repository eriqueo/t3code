import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  REVIEW_PROVIDER_INSTANCE_ID,
  TextGenerationError,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { beforeEach, describe, vi } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { makeCodexReviewDriver } from "./CodexReviewDriver.ts";

const seam = vi.hoisted(() => ({
  launcher: vi.fn(),
  adapter: vi.fn(),
  ordinary: vi.fn(),
  home: vi.fn(),
  materializeHome: vi.fn(),
}));
vi.mock("../Layers/CodexReviewRuntime.ts", () => ({
  makeCodexReviewRuntimeLauncher: seam.launcher,
}));
vi.mock("../Layers/CodexAdapter.ts", () => ({ makeCodexAdapter: seam.adapter }));
vi.mock("./CodexDriver.ts", () => ({ CodexDriver: { create: seam.ordinary } }));
vi.mock("./CodexHomeLayout.ts", () => ({
  resolveCodexHomeLayout: seam.home,
  materializeCodexShadowHome: seam.materializeHome,
}));

const launchConfig = {
  nativeDirectory: "/nix/store/00000000000000000000000000000000-codex-native-0.163.0",
  pythonPath: "/nix/store/11111111111111111111111111111111-python3/bin/python3",
  mountPath: "/nix/store/22222222222222222222222222222222-util-linux/bin/mount",
  unsharePath: "/nix/store/22222222222222222222222222222222-util-linux/bin/unshare",
  authSource: "/home/fixture/.codex/auth.json",
  path: "/nix/store/33333333333333333333333333333333-review-tools/bin",
};
const driver = makeCodexReviewDriver(launchConfig);
const isTextGenerationError = Schema.is(TextGenerationError);
const createInput = {
  instanceId: ProviderInstanceId.make(REVIEW_PROVIDER_INSTANCE_ID),
  displayName: "caller cannot rename Review",
  enabled: true,
  environment: [],
  config: {},
};
const runtimeFactory = () => Effect.die("Driver construction must not start a runtime");
const adapterEffect = vi.fn(() =>
  Effect.die("Snapshot operations must not invoke an adapter effect"),
);
const fakeAdapter = {
  provider: ProviderDriverKind.make("codex"),
  capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: true },
  compaction: { type: "native", start: adapterEffect },
  uploadFeedback: adapterEffect,
  startSession: adapterEffect,
  sendTurn: adapterEffect,
  interruptTurn: adapterEffect,
  respondToRequest: adapterEffect,
  respondToUserInput: adapterEffect,
  stopSession: adapterEffect,
  listSessions: adapterEffect,
  hasSession: adapterEffect,
  readThread: adapterEffect,
  rollbackThread: adapterEffect,
  stopAll: adapterEffect,
  streamEvents: Stream.empty,
} satisfies ProviderAdapterShape<never>;
const effects = { process: 0, http: 0 };
function untouchedService<S extends object>(name: string): S {
  return new Proxy({} as S, {
    get: (_target, key) => {
      throw new Error(`Unexpected ${name} access: ${String(key)}`);
    },
  });
}
const noEffects = Layer.mergeAll(
  // Any unexpected filesystem, path, crypto or server-config read fails loudly.
  Layer.succeed(FileSystem.FileSystem, untouchedService<FileSystem.FileSystem>("filesystem")),
  Layer.succeed(Path.Path, untouchedService<Path.Path>("path")),
  Layer.succeed(Crypto.Crypto, untouchedService<Crypto.Crypto>("crypto")),
  Layer.succeed(ServerConfig, untouchedService<ServerConfig["Service"]>("server config")),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => {
      effects.process += 1;
      return Effect.die("Review driver must not spawn during discovery");
    }),
  ),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => {
      effects.http += 1;
      return Effect.die("Review driver must not use HTTP during discovery");
    }),
  ),
);

beforeEach(() => {
  for (const mock of Object.values(seam)) mock.mockReset();
  adapterEffect.mockClear();
  effects.process = 0;
  effects.http = 0;
  seam.launcher.mockReturnValue(Effect.succeed(runtimeFactory));
  seam.adapter.mockReturnValue(Effect.succeed(fakeAdapter));
});

function assertNoDiscoveryEffects() {
  NodeAssert.deepEqual(effects, { process: 0, http: 0 });
  NodeAssert.equal(seam.ordinary.mock.calls.length, 0);
  NodeAssert.equal(seam.home.mock.calls.length, 0);
  NodeAssert.equal(seam.materializeHome.mock.calls.length, 0);
  NodeAssert.equal(adapterEffect.mock.calls.length, 0);
}

describe("dedicated Review provider driver", () => {
  it.effect(
    "constructs only the controlled runtime and read-only adapter, with optional effects removed",
    () =>
      Effect.gen(function* () {
        const instance = yield* driver.create(createInput);
        NodeAssert.equal(seam.launcher.mock.calls.length, 1);
        NodeAssert.strictEqual(seam.launcher.mock.calls[0]![0], launchConfig);
        NodeAssert.equal(seam.adapter.mock.calls.length, 1);
        const [settings, options] = seam.adapter.mock.calls[0]!;
        NodeAssert.equal(settings.binaryPath, "controlled-review");
        NodeAssert.equal(settings.launchArgs, "");
        NodeAssert.deepEqual(options, {
          instanceId: createInput.instanceId,
          readOnly: true,
          environment: {},
          makeRuntime: runtimeFactory,
        });
        NodeAssert.equal(instance.displayName, "Review");
        NodeAssert.equal(instance.continuationIdentity.continuationKey, "codex:review:ephemeral");
        NodeAssert.deepEqual(instance.adapter.capabilities, {
          sessionModelSwitch: "unsupported",
          supportsConversationRollback: false,
        });
        NodeAssert.equal(instance.adapter.compaction, undefined);
        NodeAssert.equal(instance.adapter.uploadFeedback, undefined);
        NodeAssert.equal(instance.auth, undefined);
        NodeAssert.equal(instance.consumeResetCredit, undefined);
        NodeAssert.equal(instance.refreshModels, undefined);
        NodeAssert.strictEqual(instance.adapter.startSession, fakeAdapter.startSession);
        assertNoDiscoveryEffects();
      }).pipe(Effect.provide(noEffects)),
  );

  it.effect(
    "returns a fixed model for snapshots, refresh and cwd lookup without discovery or maintenance work",
    () =>
      Effect.gen(function* () {
        const instance = yield* driver.create(createInput);
        const initial = yield* instance.snapshot.getSnapshot;
        for (const cwd of ["/development/project", "/unrelated/worktree"]) {
          const located = yield* instance.snapshotForCwd?.(cwd) ?? instance.snapshot.getSnapshot;
          NodeAssert.deepEqual(located, initial);
        }
        NodeAssert.equal(instance.snapshotForCwd, undefined);
        NodeAssert.deepEqual(yield* instance.snapshot.refresh, initial);
        NodeAssert.deepEqual(yield* instance.snapshot.resolveMaintenance({ fresh: true }), {
          provider: ProviderDriverKind.make("codex"),
          packageName: null,
          update: null,
        });
        NodeAssert.deepEqual(
          initial.models.map((model) => model.slug),
          ["gpt-6.1-sol"],
        );
        NodeAssert.equal(initial.instanceId, createInput.instanceId);
        NodeAssert.equal(initial.displayName, "Review");
        NodeAssert.equal(initial.supportsConversationRollback, false);
        NodeAssert.deepEqual(yield* Stream.runCollect(instance.snapshot.streamChanges), []);
        assertNoDiscoveryEffects();
      }).pipe(Effect.provide(noEffects)),
  );

  it.effect("rejects every background generation route without adapter or discovery effects", () =>
    Effect.gen(function* () {
      const instance = yield* driver.create(createInput);
      const modelSelection = { instanceId: createInput.instanceId, model: "gpt-6.1-sol" };
      const common = { cwd: "/development/project", message: "fixture", modelSelection };
      const requests = [
        [
          "generateBranchName",
          instance.textGeneration.generateBranchName(common).pipe(Effect.asVoid),
        ],
        [
          "generateThreadTitle",
          instance.textGeneration.generateThreadTitle(common).pipe(Effect.asVoid),
        ],
        [
          "generateCommitMessage",
          instance.textGeneration
            .generateCommitMessage({
              ...common,
              branch: null,
              stagedSummary: "fixture",
              stagedPatch: "fixture",
            })
            .pipe(Effect.asVoid),
        ],
        [
          "generatePrContent",
          instance.textGeneration
            .generatePrContent({
              ...common,
              baseBranch: "main",
              headBranch: "fixture",
              commitSummary: "fixture",
              diffSummary: "fixture",
              diffPatch: "fixture",
            })
            .pipe(Effect.asVoid),
        ],
      ] as const;
      for (const [operation, effect] of requests) {
        const error = yield* effect.pipe(Effect.flip);
        NodeAssert.ok(isTextGenerationError(error));
        NodeAssert.equal(error.operation, operation);
      }
      assertNoDiscoveryEffects();
    }).pipe(Effect.provide(noEffects)),
  );

  for (const [name, change] of [
    ["nonreserved instance", { instanceId: ProviderInstanceId.make("codex-shadow") }],
    ["disabled instance", { enabled: false }],
    [
      "environment override",
      { environment: [{ name: "PATH", value: "/development/bin", sensitive: false }] },
    ],
  ] as const) {
    it.effect(`rejects ${name} before resources or factories`, () =>
      Effect.gen(function* () {
        const error = yield* driver.create({ ...createInput, ...change }).pipe(Effect.flip);
        NodeAssert.equal(error._tag, "ProviderDriverError");
        NodeAssert.equal(seam.launcher.mock.calls.length, 0);
        NodeAssert.equal(seam.adapter.mock.calls.length, 0);
        assertNoDiscoveryEffects();
      }).pipe(Effect.provide(noEffects)),
    );
  }
});
