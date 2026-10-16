// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  ApprovalRequestId,
  ProviderDriverKind,
  ProviderInstanceId,
  REVIEW_PROVIDER_INSTANCE_ID,
  ThreadId,
  TurnId,
  type ProviderSession,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as CodexErrors from "effect-codex-app-server/errors";
import { beforeEach, describe, vi } from "vite-plus/test";

import { makeCodexReviewRuntimeLauncher } from "./CodexReviewRuntime.ts";
import type {
  CodexSessionRuntimeOptions,
  CodexSessionRuntimeShape,
} from "./CodexSessionRuntime.ts";

const seam = vi.hoisted(() => ({ makeRuntime: vi.fn() }));
vi.mock("./CodexSessionRuntime.ts", () => ({ makeCodexSessionRuntime: seam.makeRuntime }));

const config = {
  nativeDirectory: "/nix/store/00000000000000000000000000000000-codex-native-0.163.0",
  pythonPath: "/nix/store/11111111111111111111111111111111-python3/bin/python3",
  mountPath: "/nix/store/22222222222222222222222222222222-util-linux/bin/mount",
  unsharePath: "/nix/store/22222222222222222222222222222222-util-linux/bin/unshare",
  authSource: "/home/fixture/.codex/auth.json",
  path: "/nix/store/33333333333333333333333333333333-review-tools/bin",
};
const input: CodexSessionRuntimeOptions = {
  threadId: ThreadId.make("review-launcher-test"),
  providerInstanceId: ProviderInstanceId.make(REVIEW_PROVIDER_INSTANCE_ID),
  readOnly: true,
  runtimeMode: "full-access",
  cwd: "/development/project",
  homePath: "/development/home",
  binaryPath: "/development/mutable-codex",
  model: "gpt-6.1-sol",
  environment: {
    HOME: "/development/home",
    CODEX_HOME: "/development/codex",
    PATH: "/development/bin",
  },
};
const isRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);
const decodeLaunchSpec = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      workspace: Schema.String,
      nativeBinary: Schema.String,
      authSource: Schema.String,
      python: Schema.String,
    }),
  ),
);

function fakeRuntime(overrides: Partial<CodexSessionRuntimeShape> = {}) {
  const calls: string[] = [];
  const session: ProviderSession = {
    provider: ProviderDriverKind.make("codex"),
    threadId: input.threadId,
    status: "ready",
    runtimeMode: "full-access",
    cwd: "/fixture/neutral",
    createdAt: "2026-10-16T00:00:00.000Z",
    updatedAt: "2026-10-16T00:00:00.000Z",
  };
  const called = (method: string) =>
    Effect.sync(() => {
      calls.push(method);
    });
  const runtime: CodexSessionRuntimeShape = {
    start: () => called("start").pipe(Effect.as(session)),
    getSession: Effect.succeed(session),
    sendTurn: () =>
      called("sendTurn").pipe(
        Effect.as({ threadId: input.threadId, turnId: TurnId.make("fixture-turn") }),
      ),
    compactThread: called("compactThread"),
    interruptTurn: () => called("interruptTurn"),
    readThread: called("readThread").pipe(Effect.as({ threadId: "native-review", turns: [] })),
    rollbackThread: () =>
      called("rollbackThread").pipe(Effect.as({ threadId: "native-review", turns: [] })),
    uploadFeedback: () =>
      called("uploadFeedback").pipe(Effect.as({ threadId: "native-review" } as never)),
    respondToRequest: () => called("respondToRequest"),
    respondToUserInput: () => called("respondToUserInput"),
    events: Stream.empty,
    close: called("close"),
    ...overrides,
  };
  seam.makeRuntime.mockImplementation(() => Effect.succeed(runtime));
  return { runtime, calls };
}

beforeEach(() => seam.makeRuntime.mockReset());

describe("startup-owned Review launcher", () => {
  it.effect(
    "replaces ambient launch inputs and removes its private files when the session scope closes",
    () =>
      Effect.gen(function* () {
        fakeRuntime();
        const directory = yield* Effect.scoped(
          Effect.gen(function* () {
            const launch = yield* makeCodexReviewRuntimeLauncher(config);
            yield* launch(input);
            NodeAssert.equal(seam.makeRuntime.mock.calls.length, 1);
            const actual = seam.makeRuntime.mock.calls[0]![0] as CodexSessionRuntimeOptions;
            NodeAssert.ok(actual.launchCwd);
            const directory = actual.launchCwd;
            NodeAssert.equal(actual.binaryPath, NodePath.join(directory, "launch.py"));
            NodeAssert.equal(actual.cwd, NodePath.join(directory, "private", "neutral"));
            NodeAssert.equal(actual.homePath, NodePath.join(directory, "private", "home", "codex"));
            NodeAssert.deepEqual(actual.reviewPolicy, {
              cwd: actual.cwd,
              homePath: actual.homePath,
            });
            NodeAssert.equal(actual.readOnly, true);
            NodeAssert.equal(actual.model, "gpt-6.1-sol");
            NodeAssert.deepEqual(Object.keys(actual.environment ?? {}).sort(), [
              "PATH",
              "T3_REVIEW_LAUNCH_SPEC",
            ]);
            NodeAssert.equal(actual.environment?.PATH, config.path);
            const spec = decodeLaunchSpec(actual.environment!.T3_REVIEW_LAUNCH_SPEC!);
            NodeAssert.equal(spec.workspace, NodePath.join(directory, "private"));
            NodeAssert.equal(spec.nativeBinary, `${config.nativeDirectory}/bin/codex`);
            NodeAssert.equal(spec.authSource, config.authSource);
            NodeAssert.equal(spec.python, config.pythonPath);
            NodeAssert.equal(NodeFS.statSync(directory).mode & 0o777, 0o700);
            NodeAssert.equal(NodeFS.statSync(actual.binaryPath).mode & 0o777, 0o700);
            NodeAssert.equal(NodeFS.statSync(spec.workspace).mode & 0o777, 0o700);
            NodeAssert.ok(
              NodeFS.readFileSync(actual.binaryPath, "utf8").startsWith(`#!${config.pythonPath}\n`),
            );
            NodeAssert.deepEqual(NodeFS.readdirSync(spec.workspace), []);
            NodeAssert.equal(actual.appServerArgs, undefined);
            NodeAssert.equal(actual.launchArgs, undefined);
            NodeAssert.equal(actual.mcpCapabilities, undefined);
            return directory;
          }),
        );
        NodeAssert.equal(NodeFS.existsSync(directory), false);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  for (const [name, change] of [
    ["ordinary identity", { providerInstanceId: ProviderInstanceId.make("codex") }],
    ["missing readonly policy", { readOnly: false }],
    ["resume cursor", { resumeCursor: { threadId: "development-native" } }],
    ["model override", { model: "gpt-6-astra" }],
    ["launch override", { launchArgs: "--config sandbox_mode=workspace-write" }],
    ["MCP arguments", { appServerArgs: ["--config", "mcp_servers.x.command=host-tool"] }],
    ["MCP capabilities", { mcpCapabilities: new Set(["browser"]) }],
    ["MCP environment", { environment: { T3_MCP_TOKEN: "fixture-token" } }],
    ["device environment", { environment: { AGENT_DEVICE_ENDPOINT: "fixture-device" } }],
  ] as const) {
    it.effect(`rejects ${name} before launch files or runtime creation`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        let preparations = 0;
        const launch = yield* makeCodexReviewRuntimeLauncher(config).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            makeTempDirectoryScoped: (options) => {
              preparations += 1;
              return fs.makeTempDirectoryScoped(options);
            },
          }),
        );
        const error = yield* launch({ ...input, ...change }).pipe(Effect.flip);
        NodeAssert.ok(isRequestError(error));
        NodeAssert.equal(error.method, "initialize");
        NodeAssert.equal(preparations, 0);
        NodeAssert.equal(seam.makeRuntime.mock.calls.length, 0);
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  }

  it.effect("blocks auxiliary native effects while retaining turn, stop and result reads", () =>
    Effect.gen(function* () {
      const fake = fakeRuntime();
      const launch = yield* makeCodexReviewRuntimeLauncher(config);
      const runtime = yield* launch(input);
      for (const effect of [
        runtime.compactThread,
        runtime.rollbackThread(1),
        runtime.uploadFeedback("fixture"),
        runtime.respondToRequest(ApprovalRequestId.make("fixture"), "accept"),
        runtime.respondToUserInput(ApprovalRequestId.make("fixture"), {}),
      ]) {
        NodeAssert.ok(isRequestError(yield* effect.pipe(Effect.flip)));
      }
      NodeAssert.deepEqual(fake.calls, []);
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "fixture" });
      yield* runtime.interruptTurn();
      yield* runtime.readThread;
      yield* runtime.close;
      NodeAssert.deepEqual(fake.calls, [
        "start",
        "sendTurn",
        "interruptTurn",
        "readThread",
        "close",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  for (const stage of ["start", "sendTurn"] as const) {
    it.effect(`closes its runtime when ${stage} fails`, () =>
      Effect.gen(function* () {
        const failure =
          CodexErrors.CodexAppServerRequestError.invalidParams("fixture policy failure");
        const fake = fakeRuntime({ [stage]: () => Effect.fail(failure) });
        const launch = yield* makeCodexReviewRuntimeLauncher(config);
        const runtime = yield* launch(input);
        const error = yield* (
          stage === "start"
            ? runtime.start().pipe(Effect.asVoid)
            : runtime.sendTurn({ input: "fixture" }).pipe(Effect.asVoid)
        ).pipe(Effect.flip);
        NodeAssert.strictEqual(error, failure);
        NodeAssert.deepEqual(fake.calls, ["close"]);
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect(`bounds a stalled ${stage} and closes the runtime`, () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const stalled = Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
        const fake = fakeRuntime({ [stage]: () => stalled });
        const launch = yield* makeCodexReviewRuntimeLauncher(config);
        const runtime = yield* launch(input);
        const pending = yield* (
          stage === "start"
            ? runtime.start().pipe(Effect.asVoid)
            : runtime.sendTurn({ input: "fixture" }).pipe(Effect.asVoid)
        ).pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(started);
        yield* TestClock.adjust("30 seconds");
        const error = yield* Fiber.join(pending);
        NodeAssert.ok(isRequestError(error));
        NodeAssert.equal(error.method, stage === "start" ? "initialize" : "turn/start");
        NodeAssert.deepEqual(fake.calls, ["close"]);
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  }
});
