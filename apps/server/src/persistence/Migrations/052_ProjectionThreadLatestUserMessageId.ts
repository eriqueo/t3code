import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columns.some((column) => column.name === "latest_user_message_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN latest_user_message_id TEXT
    `;
  }

  yield* sql`
    UPDATE projection_threads
    SET
      latest_user_message_id = (
        SELECT message.message_id
        FROM projection_thread_messages AS message
        WHERE message.thread_id = projection_threads.thread_id
          AND message.role = 'user'
          AND message.is_streaming = 0
          AND message.message_id NOT GLOB 'import:*'
        ORDER BY message.created_at DESC, message.message_id DESC
        LIMIT 1
      ),
      latest_user_message_at = (
        SELECT message.created_at
        FROM projection_thread_messages AS message
        WHERE message.thread_id = projection_threads.thread_id
          AND message.role = 'user'
          AND message.is_streaming = 0
          AND message.message_id NOT GLOB 'import:*'
        ORDER BY message.created_at DESC, message.message_id DESC
        LIMIT 1
      )
  `;
});
