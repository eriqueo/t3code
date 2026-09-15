import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { vi } from "vite-plus/test";
import { ProcessRunner, ProcessOutputLimitError, layer as processLayer } from "../processRunner.ts";
import { makeHandoffWorkspaceObserver } from "./HandoffWorkspace.ts";
import { renderHandoffWorkspaceObservation } from "@t3tools/shared/contextHandoff";

it.layer(processLayer.pipe(Layer.provideMerge(NodeServices.layer)))("handoff workspace", (it) => {
  it.effect(
    "observes committed, dirty, detached, unborn and linked checkouts without changing them",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const runner = yield* ProcessRunner;
        const git = Effect.fn("fixture.git")(function* (cwd: string, args: string[]) {
          const result = yield* runner.run({
            command: "git",
            args: ["-C", cwd, "-c", `core.hooksPath=${NodeOS.devNull}`, ...args],
            env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: NodeOS.devNull },
            timeout: "5 seconds",
          });
          assert.strictEqual(result.code, 0, result.stderr);
          return result.stdout;
        });
        yield* git(root, ["init", "--initial-branch=main", "repo"]);
        const cwd = `${root}/repo`;
        const observe = yield* makeHandoffWorkspaceObserver;
        const unborn = yield* observe(cwd);
        assert.strictEqual(unborn.state, "observed");
        if (unborn.state !== "observed") return;
        assert.strictEqual(unborn.head, null);
        assert.strictEqual(unborn.branch, "main");
        assert.isFalse(unborn.dirty);
        yield* git(cwd, [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "--allow-empty",
          "-m",
          "fixture",
        ]);
        const before = yield* fs
          .readFile(`${cwd}/.git/index`)
          .pipe(Effect.orElseSucceed(() => null));
        const clean = yield* observe(cwd);
        assert.strictEqual(clean.state, "observed");
        if (clean.state !== "observed") return;
        assert.strictEqual(clean.head, (yield* git(cwd, ["rev-parse", "HEAD"])).trim());
        assert.isFalse(clean.dirty);
        const isolated = yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            vi.stubEnv("GIT_DIR", `${root}/wrong`);
            vi.stubEnv("GIT_WORK_TREE", root);
          }),
          () =>
            Effect.gen(function* () {
              const isolatedObserver = yield* makeHandoffWorkspaceObserver;
              return yield* isolatedObserver(cwd);
            }),
          () => Effect.sync(() => vi.unstubAllEnvs()),
        );
        assert.strictEqual(isolated.state, "observed");
        if (isolated.state === "observed")
          assert.strictEqual(isolated.statusDigest, clean.statusDigest);
        assert.strictEqual(clean.statusDigest.length, 64);
        assert.deepEqual(
          yield* fs.readFile(`${cwd}/.git/index`).pipe(Effect.orElseSucceed(() => null)),
          before,
        );
        yield* fs.writeFileString(`${cwd}/private-file`, "not included in receipt");
        const dirty = yield* observe(cwd);
        assert.strictEqual(dirty.state, "observed");
        if (dirty.state !== "observed") return;
        assert.isTrue(dirty.dirty);
        assert.notStrictEqual(dirty.statusDigest, clean.statusDigest);
        assert.notInclude(renderHandoffWorkspaceObservation(dirty), "not included in receipt");
        assert.notInclude(renderHandoffWorkspaceObservation(dirty), "private-file");
        yield* git(cwd, ["worktree", "add", "-b", "child", `${root}/child`]);
        const child = yield* observe(`${root}/child`);
        assert.strictEqual(child.state, "observed");
        if (child.state !== "observed") return;
        assert.strictEqual(child.commonDirectory, clean.commonDirectory);
        assert.strictEqual(child.branch, "child");
        assert.strictEqual(child.cwd, `${root}/child`);
        yield* git(cwd, ["checkout", "--detach"]);
        const detached = yield* observe(cwd);
        assert.strictEqual(detached.state, "observed");
        if (detached.state === "observed") assert.strictEqual(detached.branch, null);
        assert.strictEqual((yield* observe(root)).state, "unavailable");
        assert.strictEqual((yield* observe(`${root}/missing`)).state, "unavailable");
      }),
  );

  it.effect.each([
    "exit",
    "truncated",
    "encoding",
    "malformed",
    "changed",
    "overflow",
    "timeout",
  ] as const)("publishes unavailable evidence for %s without retrying", (failure) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const runner = yield* ProcessRunner;
      const initialized = yield* runner.run({
        command: "git",
        args: ["init", root],
        timeout: "5 seconds",
      });
      assert.strictEqual(initialized.code, 0);
      let statusCalls = 0;
      const entered = yield* Deferred.make<void>();
      const fake = ProcessRunner.of({
        run: (input) => {
          if (!input.args.includes("status")) return runner.run(input);
          statusCalls += 1;
          assert.strictEqual(input.env?.GIT_OPTIONAL_LOCKS, "0");
          assert.include(input.args, "core.fsmonitor=false");
          assert.strictEqual(input.maxOutputBytes, 128 * 1024);
          assert.strictEqual(input.outputMode, "error");
          if (failure === "timeout")
            return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
          if (failure === "overflow")
            return Effect.fail(
              new ProcessOutputLimitError({
                command: "git",
                argumentCount: input.args.length,
                stream: "stdout",
                maxBytes: 128 * 1024,
                observedBytes: 128 * 1024 + 1,
              }),
            );
          return Effect.succeed({
            stdout:
              failure === "malformed"
                ? "not porcelain"
                : `# branch.oid (initial)\0# branch.head ${failure === "changed" ? statusCalls : "main"}\0`,
            stderr: "private diagnostics must not be stored",
            code: ChildProcessSpawner.ExitCode(failure === "exit" ? 1 : 0),
            timedOut: false,
            stdoutTruncated: failure === "truncated",
            stderrTruncated: false,
            stdoutInvalidUtf8: failure === "encoding",
            stderrInvalidUtf8: false,
          });
        },
      });
      const observe = yield* makeHandoffWorkspaceObserver.pipe(
        Effect.provideService(ProcessRunner, fake),
      );
      const fiber = yield* observe(root).pipe(Effect.forkChild);
      if (failure === "timeout") {
        yield* Deferred.await(entered);
        yield* TestClock.adjust("10 seconds");
      }
      const observation = yield* Fiber.join(fiber);
      assert.strictEqual(observation.state, "unavailable");
      if (observation.state === "unavailable")
        assert.strictEqual(
          observation.code,
          failure === "timeout"
            ? "timed_out"
            : failure === "changed"
              ? "changed_during_observation"
              : "inspection_failed",
        );
      assert.strictEqual(statusCalls, failure === "changed" || failure === "malformed" ? 2 : 1);
      assert.notInclude(renderHandoffWorkspaceObservation(observation), "private diagnostics");
    }),
  );
});
