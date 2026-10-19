import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class V2DatabaseImportError extends Schema.TaggedError<V2DatabaseImportError>()(
  "V2DatabaseImportError",
  { sourcePath: Schema.String, destinationPath: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Could not copy the V1 database at ${this.sourcePath} to ${this.destinationPath}. The V1 database has not been migrated.`;
  }
}

// Permanent fork upgrade path. These ids were allocated before upstream's V2
// migrations. Reconcile only the unpublished copy: the original V1 history and
// the custom tables/reservation keys remain intact for rollback and import.
const forkV1Migrations = [
  [52, "ProjectionThreadLatestUserMessageId"],
  [53, "LogicalProjects"],
  [54, "TestRuns"],
] as const;

function reconcileForkSnapshot(snapshotPath: string): void {
  const snapshot = new NodeSqlite.DatabaseSync(snapshotPath);
  try {
    const hasHistory = snapshot
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'",
      )
      .get();
    if (!hasHistory) return;
    const history = snapshot
      .prepare(
        "SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 52 ORDER BY migration_id",
      )
      .all();
    if (
      !history.some((row) =>
        forkV1Migrations.some(([id, name]) => row.migration_id === id && row.name === name),
      )
    )
      return;
    if (
      !history.every((row, index) => {
        const expected = forkV1Migrations[index];
        return (
          expected !== undefined && row.migration_id === expected[0] && row.name === expected[1]
        );
      })
    ) {
      throw new Error("Cannot import mixed or unknown fork migration history.");
    }
    snapshot.exec("BEGIN IMMEDIATE");
    const remove = snapshot.prepare(
      "DELETE FROM effect_sql_migrations WHERE migration_id = ? AND name = ?",
    );
    for (const [id, name] of forkV1Migrations) remove.run(id, name);
    snapshot.exec("COMMIT");
  } finally {
    snapshot.close();
  }
}

/** Its copied legacy tables remain the source for lazy transcript import. */
export const initializeV2Database = Effect.fn("initializeV2Database")(function* (
  destinationPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(destinationPath);
  const sourcePath = path.join(directory, "state.sqlite");
  yield* Effect.gen(function* () {
    if (yield* fs.exists(destinationPath)) return;
    if (!(yield* fs.exists(sourcePath))) return;
    const temporaryDirectory = yield* fs.makeTempDirectoryScoped({
      directory,
      prefix: ".v2-import-",
    });
    const snapshotPath = path.join(temporaryDirectory, "snapshot.sqlite");
    yield* Effect.tryPromise(async () => {
      const database = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
      try {
        await NodeSqlite.backup(database, snapshotPath);
      } finally {
        database.close();
      }
      reconcileForkSnapshot(snapshotPath);
    });
    // Publish only a complete snapshot, without replacing an existing V2 database.
    yield* fs
      .link(snapshotPath, destinationPath)
      .pipe(
        Effect.catch((error) =>
          error.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(error),
        ),
      );
  }).pipe(
    Effect.scoped,
    Effect.mapError((cause) => new V2DatabaseImportError({ sourcePath, destinationPath, cause })),
  );
});
