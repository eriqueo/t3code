import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// CRITICAL: retain request keys until explicit operator retirement. Deleting a
// key permits execution again. Each receipt is bounded by the wire contract;
// stdout/stderr and file contents are never persisted. Additive rollback: old
// binaries leave this table unused; never roll back by deleting reservations.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE test_runs (
    request_id TEXT PRIMARY KEY, input_json TEXT NOT NULL,
    cwd TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)),
    receipt_json TEXT NOT NULL
  )`;
  yield* sql`CREATE UNIQUE INDEX test_runs_active_checkout ON test_runs(cwd) WHERE active = 1`;
  yield* sql`CREATE INDEX test_runs_thread_recent ON test_runs(
    json_extract(receipt_json,'$.input.threadId'),
    json_extract(receipt_json,'$.reservedAt') DESC, request_id DESC
  )`;
});
