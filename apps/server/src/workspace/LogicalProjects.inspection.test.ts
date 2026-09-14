import { vi } from "vite-plus/test";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ProcessRunner, layer as processLayer } from "../processRunner.ts";
import { makeCheckoutInspector } from "./LogicalProjects.ts";

it.layer(processLayer.pipe(Layer.provideMerge(NodeServices.layer)))("checkout inspection", (it) => {
  it.effect(
    "canonicalizes aliases, shares linked-worktree identity, distinguishes clones, and rejects nonrepositories",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const runner = yield* ProcessRunner;
        const gitEnvironment = {
          ...Object.fromEntries(
            Object.keys(process.env)
              .filter((key) => key.startsWith("GIT_"))
              .map((key) => [key, undefined]),
          ),
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: NodeOS.devNull,
        };
        const git = Effect.fn("fixture.git")(function* (args: string[]) {
          const result = yield* runner.run({
            command: "git",
            args: ["-c", `core.hooksPath=${NodeOS.devNull}`, ...args],
            env: gitEnvironment,
            timeout: "10 seconds",
          });
          assert.strictEqual(result.code, 0, result.stderr);
          return result;
        });
        yield* git(["init", `${root}/repo`]);
        yield* git([
          "-C",
          `${root}/repo`,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "--allow-empty",
          "-m",
          "fixture",
        ]);
        yield* git(["-C", `${root}/repo`, "worktree", "add", "-b", "child", `${root}/child`]);
        yield* git(["clone", `${root}/repo`, `${root}/clone`]);
        yield* fs.symlink(`${root}/repo`, `${root}/alias`);
        const inspect = yield* makeCheckoutInspector;
        const original = yield* inspect(`${root}/repo`);
        const cleanIdentity = yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            vi.stubEnv("GIT_DIR", `${root}/clone/.git`);
            vi.stubEnv("GIT_WORK_TREE", `${root}/clone`);
          }),
          () =>
            Effect.gen(function* () {
              const isolated = yield* makeCheckoutInspector;
              return yield* isolated(`${root}/repo`);
            }),
          () => Effect.sync(() => vi.unstubAllEnvs()),
        );
        assert.deepEqual(cleanIdentity, original);
        assert.deepEqual(yield* inspect(`${root}/alias`), original);
        assert.strictEqual(
          (yield* inspect(`${root}/child`)).commonDirectory,
          original.commonDirectory,
        );
        assert.notStrictEqual(
          (yield* inspect(`${root}/clone`)).commonDirectory,
          original.commonDirectory,
        );
        assert.strictEqual((yield* inspect(root).pipe(Effect.flip)).code, "invalid_checkout");
        yield* git(["-C", `${root}/repo`, "worktree", "add", "-b", "sibling", `${root}/sibling`]);
        yield* fs.writeFileString(
          `${root}/child/.git`,
          yield* fs.readFileString(`${root}/sibling/.git`),
        );
        assert.strictEqual(
          (yield* inspect(`${root}/child`).pipe(Effect.flip)).code,
          "invalid_checkout",
        );
        yield* fs.remove(`${root}/child/.git`);
        yield* fs.symlink(`${root}/sibling/.git`, `${root}/child/.git`);
        assert.strictEqual(
          (yield* inspect(`${root}/child`).pipe(Effect.flip)).code,
          "invalid_checkout",
        );
        yield* fs.makeDirectory(`${root}/repo/sub`);
        assert.strictEqual(
          (yield* inspect(`${root}/repo/sub`).pipe(Effect.flip)).code,
          "invalid_checkout",
        );
        const before = yield* git(["-C", `${root}/repo`, "status", "--porcelain=v1"]);
        yield* inspect(`${root}/repo`);
        assert.strictEqual(
          (yield* git(["-C", `${root}/repo`, "status", "--porcelain=v1"])).stdout,
          before.stdout,
        );
      }),
  );
});
