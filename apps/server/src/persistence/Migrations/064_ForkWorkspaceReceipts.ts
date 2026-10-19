import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// CRITICAL: retain ownership receipts and test execution reservation keys until
// explicit retirement. Existing fork tables are preserved by snapshot import.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS logical_projects (
    logical_project_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
    title TEXT NOT NULL, version INTEGER NOT NULL CHECK(version = 1)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS logical_project_bindings (
    logical_project_id TEXT NOT NULL REFERENCES logical_projects(logical_project_id),
    common_directory TEXT NOT NULL, checkout_path TEXT NOT NULL UNIQUE,
    PRIMARY KEY(logical_project_id, common_directory)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS logical_project_registration_receipts (
    request_id TEXT PRIMARY KEY, input_json TEXT NOT NULL, receipt_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS test_runs (
    request_id TEXT PRIMARY KEY, input_json TEXT NOT NULL,
    cwd TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)),
    receipt_json TEXT NOT NULL
  )`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS test_runs_active_checkout ON test_runs(cwd) WHERE active = 1`;
  yield* sql`CREATE INDEX IF NOT EXISTS test_runs_thread_recent ON test_runs(
    json_extract(receipt_json,'$.input.threadId'),
    json_extract(receipt_json,'$.reservedAt') DESC, request_id DESC
  )`;
});
