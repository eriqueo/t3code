import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId, TestRunInput, TestRunReceipt } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import { ProcessRunner, layer as processLayer } from "../processRunner.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { makeTestRuns } from "./TestRuns.ts";
import { makeTestWorkspaceObserver } from "./TestWorkspace.ts";
const encodeInput = Schema.encodeEffect(Schema.fromJsonString(TestRunInput));
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(TestRunReceipt));

const environment = Layer.mergeAll(
  NodeSqliteClient.layer({ filename: ":memory:" }),
  processLayer.pipe(Layer.provideMerge(NodeServices.layer)),
);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const sql = yield* SqlClient.SqlClient;
  const runner = yield* ProcessRunner;
  const root = yield* fs.makeTempDirectoryScoped();
  const git = yield* runner.run({ command: "git", args: ["init", "--initial-branch=main", root] });
  assert.strictEqual(git.code, 0);
  yield* fs.writeFileString(`${root}/.gitignore`, "ignored\n");
  yield* fs.writeFileString(`${root}/source`, "first");
  yield* runMigrations();
  yield* sql`DELETE FROM test_runs`;
  yield* sql`DELETE FROM orchestration_v2_projection_threads`;
  yield* sql`DELETE FROM projection_projects`;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','Test',${root},'[]','now','now')`;
  yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','Test','codex','full-access','default','now','now','{"worktreePath":null}')`;
  return { fs, sql, root, runs: yield* makeTestRuns };
});
const input = (requestId: string, script = "process.exit(0)"): TestRunInput => ({
  version: 1,
  requestId,
  threadId: ThreadId.make("t"),
  command: process.execPath,
  args: ["-e", script],
  timeoutSeconds: 5,
});

it.layer(environment)("explicit test runner", (it) => {
  it.effect("does not lose an observed exit when the after fingerprint is interrupted", () =>
    Effect.gen(function* () {
      yield* fixture;
      const real = yield* ProcessRunner;
      const afterStarted = yield* Deferred.make<void>();
      let exited = false;
      const controlled = ProcessRunner.of({
        run: (command) => {
          if (exited && command.command === "git")
            return Effect.gen(function* () {
              yield* Deferred.succeed(afterStarted, undefined);
              return yield* Effect.never;
            });
          return real.run(command).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (command.command === process.execPath) exited = true;
              }),
            ),
          );
        },
      });
      const runs = yield* makeTestRuns.pipe(Effect.provideService(ProcessRunner, controlled));
      const fiber = yield* runs
        .run(input("after-interrupted", "process.exit(4)"), "actor")
        .pipe(Effect.forkChild);
      yield* Deferred.await(afterStarted);
      assert.strictEqual((yield* runs.get("after-interrupted")).exitCode, 4);
      yield* Fiber.interrupt(fiber);
      const receipt = yield* runs.get("after-interrupted");
      assert.strictEqual(receipt.exitCode, 4);
      assert.isNotNull(receipt.exitedAt);
      assert.strictEqual(receipt.after, null);
      assert.strictEqual(receipt.revisionValidity, "unknown");
      assert.strictEqual(receipt.state, "outcome_unknown");
    }),
  );
  it.effect("reports bounded fingerprint failure without starting the command", () =>
    Effect.gen(function* () {
      const { runs, fs, root } = yield* fixture;
      yield* fs.writeFileString(`${root}/large`, "");
      yield* fs.truncate(`${root}/large`, 33 * 1024 * 1024);
      const result = yield* runs.run(input("large", "throw new Error('must not run')"), "actor");
      assert.strictEqual(result.state, "not_started");
      assert.strictEqual(result.startedAt, null);
      assert.strictEqual(result.before?.state, "unavailable");
      if (result.before?.state === "unavailable")
        assert.strictEqual(result.before.code, "limit_exceeded");
    }),
  );
  it.effect("preserves exit when post-command observation fails", () =>
    Effect.gen(function* () {
      const { runs } = yield* fixture;
      const changed = yield* runs.run(
        input(
          "large-after",
          "const fs=require('node:fs');fs.writeFileSync('large','');fs.truncateSync('large',33*1024*1024)",
        ),
        "actor",
      );
      assert.strictEqual(changed.state, "completed");
      assert.strictEqual(changed.exitCode, 0);
      assert.strictEqual(changed.revisionValidity, "unknown");
      assert.strictEqual(changed.after?.state, "unavailable");
    }),
  );
  it.effect("keeps spawn failure unknown and does not retry it", () =>
    Effect.gen(function* () {
      const { runs } = yield* fixture;
      const spec = {
        ...input("missing-executable"),
        command: "/t3-fixture-nonexistent-executable",
      };
      const result = yield* runs.run(spec, "actor");
      assert.strictEqual(result.state, "outcome_unknown");
      assert.strictEqual(result.reason, "execution_failed");
      assert.strictEqual(result.exitCode, null);
      assert.deepEqual(yield* runs.run(spec, "actor"), result);
    }),
  );
  it.effect(
    "reserves before spawn, rejects concurrent execution, and preserves cancelled outcomes",
    () =>
      Effect.gen(function* () {
        yield* fixture;
        const real = yield* ProcessRunner;
        const entered = yield* Deferred.make<void>();
        let starts = 0;
        const controlled = ProcessRunner.of({
          run: (command) =>
            command.command === "controlled"
              ? Effect.gen(function* () {
                  starts++;
                  yield* Deferred.succeed(entered, undefined);
                  return yield* Effect.never;
                })
              : real.run(command),
        });
        const runs = yield* makeTestRuns.pipe(Effect.provideService(ProcessRunner, controlled));
        const spec = { ...input("cancelled"), command: "controlled" };
        const fiber = yield* runs.run(spec, "actor").pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        assert.strictEqual((yield* runs.get(spec.requestId)).state, "running");
        assert.strictEqual((yield* runs.run(spec, "actor")).state, "running");
        assert.strictEqual(
          (yield* runs.run(input("parallel"), "actor").pipe(Effect.flip)).code,
          "workspace_busy",
        );
        assert.strictEqual(
          (yield* runs
            .release({ requestId: spec.requestId, processStopped: true }, "actor")
            .pipe(Effect.flip)).code,
          "still_running",
        );
        yield* Fiber.interrupt(fiber);
        const cancelled = yield* runs.get(spec.requestId);
        assert.strictEqual(cancelled.state, "outcome_unknown");
        assert.strictEqual(cancelled.reason, "interrupted");
        assert.deepEqual(yield* runs.run(spec, "actor"), cancelled);
        assert.strictEqual(starts, 1);
      }),
  );
  it.effect(
    "runs once, retains exact argv and exit, and replays after service reconstruction",
    () =>
      Effect.gen(function* () {
        const { runs, fs, root } = yield* fixture;
        const spec = input(
          "once",
          "require('node:fs').appendFileSync('ignored','once');process.exit(7)",
        );
        const receipt = yield* runs.run(spec, "actor");
        assert.strictEqual(receipt.state, "completed");
        assert.strictEqual(receipt.exitCode, 7);
        assert.strictEqual(receipt.revisionValidity, "matching_observations");
        assert.deepEqual(receipt.input, spec);
        assert.strictEqual(receipt.actorSessionId, "actor");
        const restarted = yield* makeTestRuns;
        assert.deepEqual(yield* restarted.run(spec, "another-actor"), receipt);
        assert.strictEqual(yield* fs.readFileString(`${root}/ignored`), "once");
        const conflict = yield* restarted.run({ ...spec, args: [] }, "actor").pipe(Effect.flip);
        assert.strictEqual(conflict.code, "request_conflict");
        assert.deepEqual(yield* restarted.get("once"), receipt);
      }),
  );
  it.effect("binds exit to content observations even when dirty status stays the same", () =>
    Effect.gen(function* () {
      const { runs } = yield* fixture;
      const receipt = yield* runs.run(
        input("changed", "require('node:fs').writeFileSync('source','second')"),
        "actor",
      );
      assert.strictEqual(receipt.exitCode, 0);
      assert.strictEqual(receipt.revisionValidity, "changed");
      assert.strictEqual(receipt.before?.state, "observed");
      assert.strictEqual(receipt.after?.state, "observed");
    }),
  );
  it.effect("refuses effects when the fingerprint is unavailable", () =>
    Effect.gen(function* () {
      const { runs, fs, root } = yield* fixture;
      // A checked-out gitlink needs recursive evidence, which this slice does not supply.
      const runner = yield* ProcessRunner;
      assert.strictEqual(
        (yield* runner.run({
          command: "git",
          args: [
            "-C",
            root,
            "update-index",
            "--add",
            "--cacheinfo",
            "160000,1111111111111111111111111111111111111111,submodule",
          ],
        })).code,
        0,
      );
      yield* fs.makeDirectory(`${root}/submodule`);
      const receipt = yield* runs.run(
        input("unsupported", "require('node:fs').writeFileSync('ignored','ran')"),
        "actor",
      );
      assert.strictEqual(receipt.state, "not_started");
      assert.strictEqual(receipt.reason, "fingerprint_unavailable");
      assert.isFalse(yield* fs.exists(`${root}/ignored`));
    }),
  );
  it.effect(
    "holds unknown reservations across restart and requires explicit release without replay",
    () =>
      Effect.gen(function* () {
        const { runs, sql, root } = yield* fixture;
        const spec = input("crashed");
        const receipt: TestRunReceipt = {
          version: 1,
          input: spec,
          actorSessionId: "old",
          cwd: root,
          reservedAt: "1960-01-01T00:00:00Z",
          deadlineAt: "1960-01-01T00:01:00Z",
          state: "running",
          startedAt: null,
          exitedAt: null,
          completedAt: null,
          exitCode: null,
          reason: null,
          before: null,
          after: null,
          revisionValidity: "unknown",
          releasedBy: null,
        };
        const specJson = yield* encodeInput(spec);
        const receiptJson = yield* encodeReceipt(receipt);
        yield* sql`INSERT INTO test_runs VALUES('crashed',${specJson},${root},1,${receiptJson})`;
        assert.strictEqual((yield* runs.get("crashed")).state, "outcome_unknown");
        assert.strictEqual((yield* runs.run(spec, "new")).state, "outcome_unknown");
        assert.strictEqual(
          (yield* runs.run(input("other"), "new").pipe(Effect.flip)).code,
          "workspace_busy",
        );
        const released = yield* runs.release(
          { requestId: "crashed", processStopped: true },
          "operator",
        );
        assert.strictEqual(released.releasedBy, "operator");
        assert.strictEqual((yield* runs.run(spec, "new")).state, "outcome_unknown");
        assert.strictEqual((yield* runs.run(input("other"), "new")).state, "completed");
      }),
  );
  it.effect(
    "content fingerprint excludes ignored inputs but includes symlink targets and file modes",
    () =>
      Effect.gen(function* () {
        const { fs, root } = yield* fixture;
        const observe = yield* makeTestWorkspaceObserver;
        const first = yield* observe(root);
        yield* fs.writeFileString(`${root}/ignored`, "dependency is outside scope");
        const second = yield* observe(root);
        assert.strictEqual(first.state, "observed");
        assert.strictEqual(second.state, "observed");
        if (first.state !== "observed" || second.state !== "observed") return;
        assert.strictEqual(first.digest, second.digest);
        yield* fs.chmod(`${root}/source`, 0o755);
        const third = yield* observe(root);
        assert.strictEqual(third.state, "observed");
        if (third.state === "observed") assert.notStrictEqual(third.digest, first.digest);
      }),
  );
});
