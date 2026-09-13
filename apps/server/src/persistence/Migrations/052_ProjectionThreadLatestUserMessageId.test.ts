import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";
import migrateLatestUserMessageId from "./052_ProjectionThreadLatestUserMessageId.ts";

it.layer(NodeSqliteClient.layerMemory())("052_ProjectionThreadLatestUserMessageId", (it) => {
  it.effect("backfills the latest live user-message revision and is repeatable", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 51 });
      const now = "2026-09-13T00:00:00.000Z";
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          created_at, updated_at
        ) VALUES (
          'thread-1', 'project-1', 'Existing thread',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', ${now}, ${now}
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES
          ('message-old', 'thread-1', 'user', 'Old', 0, '2026-09-12T00:00:00.000Z', ${now}),
          ('message-latest', 'thread-1', 'user', 'Latest', 0, '2026-09-13T00:00:00.000Z', ${now}),
          ('message-streaming', 'thread-1', 'user', 'Streaming', 1, '2026-09-15T00:00:00.000Z', ${now}),
          ('import:codex:newer', 'thread-1', 'user', 'Imported', 0, '2026-09-14T00:00:00.000Z', ${now})
      `;

      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* migrateLatestUserMessageId;

      const rows = yield* sql<{
        readonly latestUserMessageId: string | null;
        readonly latestUserMessageAt: string | null;
      }>`
        SELECT
          latest_user_message_id AS "latestUserMessageId",
          latest_user_message_at AS "latestUserMessageAt"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(rows, [
        {
          latestUserMessageId: "message-latest",
          latestUserMessageAt: "2026-09-13T00:00:00.000Z",
        },
      ]);
    }),
  );
});
