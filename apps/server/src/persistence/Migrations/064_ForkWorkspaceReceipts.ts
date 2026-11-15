import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Migrator from "effect/sql/Migrator";

// This former numeric migration now belongs to the independent fork ledger.
// Keep its schema unchanged so existing ownership and reservation receipts survive.
const statements = [
  "CREATE TABLE IF NOT EXISTS logical_projects (\n    logical_project_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,\n    title TEXT NOT NULL, version INTEGER NOT NULL CHECK(version = 1)\n  )",
  "CREATE TABLE IF NOT EXISTS logical_project_bindings (\n    logical_project_id TEXT NOT NULL REFERENCES logical_projects(logical_project_id),\n    common_directory TEXT NOT NULL, checkout_path TEXT NOT NULL UNIQUE,\n    PRIMARY KEY(logical_project_id, common_directory)\n  )",
  "CREATE TABLE IF NOT EXISTS logical_project_registration_receipts (\n    request_id TEXT PRIMARY KEY, input_json TEXT NOT NULL, receipt_json TEXT NOT NULL\n  )",
  "CREATE TABLE IF NOT EXISTS test_runs (\n    request_id TEXT PRIMARY KEY, input_json TEXT NOT NULL,\n    cwd TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)),\n    receipt_json TEXT NOT NULL\n  )",
  "CREATE UNIQUE INDEX IF NOT EXISTS test_runs_active_checkout ON test_runs(cwd) WHERE active = 1",
  "CREATE INDEX IF NOT EXISTS test_runs_thread_recent ON test_runs(\n    json_extract(receipt_json,'$.input.threadId'),\n    json_extract(receipt_json,'$.reservedAt') DESC, request_id DESC\n  )",
] as const;
export const forkMigrationKey = "workspace-receipts-v1";

const normalize = (sql: string) => sql.replace(/IF NOT EXISTS/gi, "").replace(/\s+/g, "");

export const assertForkWorkspaceSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of statements) {
    const name = /(?:TABLE|INDEX) IF NOT EXISTS (\w+)/.exec(statement)![1]!;
    const rows = yield* sql<{
      readonly sql: string;
    }>`SELECT sql FROM sqlite_master WHERE name = ${name}`;
    if (rows.length !== 1 || normalize(rows[0]!.sql) !== normalize(statement)) {
      return yield* new Migrator.MigrationError({
        kind: "BadState",
        message: `Unrecognized fork workspace schema: ${name}. No migration history was changed.`,
      });
    }
  }
});

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of statements) yield* sql.unsafe(statement);
});

const ensureForkLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS hwc_schema_migrations (
    name TEXT PRIMARY KEY,
    legacy_migration_id INTEGER,
    legacy_migration_name TEXT,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`;
});

export const recordForkMigration = Effect.fn("recordForkMigration")(function* (legacy: boolean) {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureForkLedger;
  yield* sql`INSERT INTO hwc_schema_migrations (name, legacy_migration_id, legacy_migration_name)
    VALUES (${forkMigrationKey}, ${legacy ? 64 : null}, ${legacy ? "ForkWorkspaceReceipts" : null})`;
});
