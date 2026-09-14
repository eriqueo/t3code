import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// CRITICAL ownership metadata: retained until explicit retirement is implemented.
// Registration never grants execution authority. Existing project/thread rows are untouched.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE logical_projects (
    logical_project_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
    title TEXT NOT NULL, version INTEGER NOT NULL CHECK(version = 1)
  )`;
  yield* sql`CREATE TABLE logical_project_bindings (
    logical_project_id TEXT NOT NULL REFERENCES logical_projects(logical_project_id),
    common_directory TEXT NOT NULL, checkout_path TEXT NOT NULL UNIQUE,
    PRIMARY KEY(logical_project_id, common_directory)
  )`;
  yield* sql`CREATE TABLE logical_project_registration_receipts (
    request_id TEXT PRIMARY KEY, input_json TEXT NOT NULL, receipt_json TEXT NOT NULL
  )`;
});
