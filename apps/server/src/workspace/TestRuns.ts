import {
  TestRunError,
  TestRunInput,
  TestRunReceipt,
  type TestRunRelease,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProcessRunner } from "../processRunner.ts";
import { makeCheckoutInspector } from "./LogicalProjects.ts";
import { makeTestWorkspaceObserver } from "./TestWorkspace.ts";
import { testRunAtTime } from "./TestRunReceipts.ts";

const encodeInput = Schema.encodeEffect(Schema.fromJsonString(TestRunInput));
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(TestRunReceipt));
const decodeReceipt = Schema.decodeEffect(Schema.fromJsonString(TestRunReceipt));
const isTestRunError = Schema.is(TestRunError);
const error = (code: TestRunError["code"]) => new TestRunError({ code });
const stored = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError(() => error("storage_failed")));
export const makeTestRuns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runner = yield* ProcessRunner;
  const inspect = yield* makeCheckoutInspector;
  const observe = yield* makeTestWorkspaceObserver;
  // Bounded by the four persisted active slots; protects release against clock
  // jumps while this service still owns an executing request.
  const executing = new Set<string>();
  const now = Effect.map(DateTime.now, DateTime.formatIso);
  const save = Effect.fnUntraced(function* (receipt: TestRunReceipt, active: boolean) {
    const json = yield* stored(encodeReceipt(receipt));
    yield* stored(
      sql`UPDATE test_runs SET receipt_json=${json}, active=${active ? 1 : 0} WHERE request_id=${receipt.input.requestId}`,
    );
    return receipt;
  });
  const get = Effect.fn("TestRuns.get")(function* (requestId: string) {
    const rows = yield* stored(
      sql<{
        receipt_json: string;
      }>`SELECT receipt_json FROM test_runs WHERE request_id=${requestId}`,
    );
    if (!rows[0]) return yield* error("request_missing");
    const receipt = yield* stored(decodeReceipt(rows[0].receipt_json));
    // A crashed server cannot prove its child stopped. Keep its slot until an
    // operator confirms that fact; reading never retries or releases a run.
    return testRunAtTime(receipt, yield* now);
  });
  const run = Effect.fn("TestRuns.run")(function* (input: TestRunInput, actorSessionId: string) {
    const inputJson = yield* stored(encodeInput(input));
    const replay = Effect.gen(function* () {
      const rows = yield* stored(
        sql<{
          input_json: string;
        }>`SELECT input_json FROM test_runs WHERE request_id=${input.requestId}`,
      );
      if (!rows[0]) return null;
      if (rows[0].input_json !== inputJson) return yield* error("request_conflict");
      return yield* get(input.requestId);
    });
    const previous = yield* replay;
    if (previous) return previous;
    const rows = yield* stored(sql<{
      cwd: string;
    }>`SELECT COALESCE(NULLIF(t.worktree_path,''),p.workspace_root) AS cwd
      FROM projection_threads t JOIN projection_projects p ON p.project_id=t.project_id
      WHERE t.thread_id=${input.threadId} AND t.deleted_at IS NULL AND p.deleted_at IS NULL`);
    if (!rows[0]) return yield* error("thread_missing");
    const identity = yield* inspect(rows[0].cwd).pipe(
      Effect.mapError(() => error("invalid_checkout")),
    );
    const reservedAt = yield* now;
    let receipt: TestRunReceipt = {
      version: 1,
      input,
      actorSessionId,
      cwd: identity.checkoutPath,
      reservedAt,
      deadlineAt: DateTime.formatIso(
        DateTime.add(yield* DateTime.now, { seconds: input.timeoutSeconds + 130 }),
      ),
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
    // Atomic key + checkout reservation precedes all command effects. A maximum
    // of four active runs sheds excess requests; there is no execution queue.
    const reserved = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* replay;
          if (existing) return existing;
          const busy = yield* stored(
            sql`SELECT request_id FROM test_runs WHERE active=1 AND cwd=${identity.checkoutPath}`,
          );
          const count = yield* stored(
            sql<{ count: number }>`SELECT COUNT(*) AS count FROM test_runs WHERE active=1`,
          );
          if (busy.length || (count[0]?.count ?? 0) >= 4) return yield* error("workspace_busy");
          const json = yield* stored(encodeReceipt(receipt));
          yield* stored(
            sql`INSERT INTO test_runs(request_id,input_json,cwd,active,receipt_json) VALUES(${input.requestId},${inputJson},${identity.checkoutPath},1,${json})`,
          );
          return null;
        }),
      )
      .pipe(Effect.mapError((cause) => (isTestRunError(cause) ? cause : error("storage_failed"))));
    if (reserved) return reserved;
    executing.add(input.requestId);
    const execute = Effect.gen(function* () {
      const before = yield* observe(identity.checkoutPath);
      receipt = { ...receipt, before };
      if (
        before.state !== "observed" ||
        before.cwd !== identity.checkoutPath ||
        before.commonDirectory !== identity.commonDirectory
      )
        return yield* save(
          {
            ...receipt,
            state: "not_started",
            reason: "fingerprint_unavailable",
            completedAt: yield* now,
          },
          false,
        );
      receipt = { ...receipt, startedAt: yield* now };
      yield* save(receipt, true);
      const output = yield* runner
        .run({
          command: input.command,
          args: input.args,
          cwd: identity.checkoutPath,
          timeout: `${input.timeoutSeconds} seconds`,
          maxOutputBytes: 1024 * 1024,
          outputMode: "truncate",
          timeoutBehavior: "timedOutResult",
        })
        .pipe(
          Effect.map((result) => ({ result })),
          Effect.catch((cause) => Effect.succeed({ cause })),
        );
      const result = "result" in output ? output.result : null;
      const knownExit = result !== null && !result.timedOut && result.code !== null;
      // Persist the authoritative exit before post-command I/O: cancellation
      // during the after observation must not erase an already observed exit.
      receipt = {
        ...receipt,
        exitCode: result?.code ?? null,
        exitedAt: knownExit ? yield* now : null,
      };
      yield* save(receipt, true);
      const after = yield* observe(identity.checkoutPath);
      receipt = {
        ...receipt,
        after,
        completedAt: yield* now,
        state: knownExit ? "completed" : "outcome_unknown",
        exitCode: result?.code ?? null,
        reason: knownExit ? null : result?.timedOut ? "timed_out" : "execution_failed",
        revisionValidity:
          after.state !== "observed"
            ? "unknown"
            : before.digest === after.digest &&
                before.head === after.head &&
                before.branch === after.branch &&
                before.statusDigest === after.statusDigest &&
                before.commonDirectory === after.commonDirectory &&
                before.cwd === after.cwd
              ? "matching_observations"
              : "changed",
      };
      return yield* save(receipt, !knownExit);
    });
    // Cancellation kills the scoped child through ProcessRunner. We still do
    // not infer that descendants or external effects stopped.
    return yield* execute.pipe(
      Effect.onExit((exit) =>
        exit._tag === "Failure"
          ? save({ ...receipt, state: "outcome_unknown", reason: "interrupted" }, true).pipe(
              Effect.ignore({ log: true }),
            )
          : Effect.void,
      ),
      Effect.ensuring(Effect.sync(() => executing.delete(input.requestId))),
    );
  });
  const release = Effect.fn("TestRuns.release")(function* (
    input: TestRunRelease,
    actorSessionId: string,
  ) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const receipt = yield* get(input.requestId);
          if (receipt.state === "running" || executing.has(input.requestId))
            return yield* error("still_running");
          if (receipt.releasedBy !== null || receipt.state !== "outcome_unknown") return receipt;
          return yield* save({ ...receipt, releasedBy: actorSessionId }, false);
        }),
      )
      .pipe(Effect.mapError((cause) => (isTestRunError(cause) ? cause : error("storage_failed"))));
  });
  return { run, get, release };
});
export class TestRuns extends Context.Service<TestRuns, Effect.Success<typeof makeTestRuns>>()(
  "t3/workspace/TestRuns",
) {
  static readonly layer = Layer.effect(this, makeTestRuns);
}
