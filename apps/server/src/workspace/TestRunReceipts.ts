import {
  HANDOFF_TEST_RECEIPT_LIMIT,
  HANDOFF_TEST_COMMAND_MAX_LENGTH,
  TestRunReceipt,
  type HandoffTestEvidence,
  type HandoffTestReceipt,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const decodeReceipt = Schema.decodeEffect(Schema.fromJsonString(TestRunReceipt));
export const testRunAtTime = (receipt: TestRunReceipt, at: string): TestRunReceipt =>
  receipt.state === "running" && at > receipt.deadlineAt
    ? { ...receipt, state: "outcome_unknown", reason: "deadline_elapsed" }
    : receipt;

// Read-only: does not load the execution service or change a reservation. Its
// snapshot shares the ready activity's retention; full argv stays in test_runs.
export const makeHandoffTestCollector = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return Effect.fn("TestRunReceipts.collect")(function* (
    threadId: ThreadId,
    preparationCwd: string | null,
  ) {
    const collectedAt = DateTime.formatIso(yield* DateTime.now);
    const unavailable = (code: "read_failed" | "timed_out"): HandoffTestEvidence => ({
      version: 1,
      state: "unavailable",
      collectedAt,
      code,
    });
    const collect = Effect.gen(function* () {
      const rows = yield* sql<{ receipt_json: string }>`SELECT receipt_json FROM test_runs
        WHERE json_extract(receipt_json,'$.input.threadId')=${threadId}
        ORDER BY json_extract(receipt_json,'$.reservedAt') DESC, request_id DESC
        LIMIT ${HANDOFF_TEST_RECEIPT_LIMIT + 1}`;
      const items: HandoffTestReceipt[] = [];
      for (const row of rows.slice(0, HANDOFF_TEST_RECEIPT_LIMIT)) {
        const receipt = testRunAtTime(yield* decodeReceipt(row.receipt_json), collectedAt);
        items.push({
          requestId: receipt.input.requestId,
          command:
            receipt.input.command.length <= HANDOFF_TEST_COMMAND_MAX_LENGTH
              ? receipt.input.command
              : null,
          reservedAt: receipt.reservedAt,
          exitedAt: receipt.exitedAt,
          state: receipt.state,
          exitCode: receipt.exitCode,
          reason: receipt.reason,
          revisionValidity: receipt.revisionValidity,
          checkoutPathMatchesPreparation:
            preparationCwd === null ? null : receipt.cwd === preparationCwd,
          beforeDigest: receipt.before?.state === "observed" ? receipt.before.digest : null,
          afterDigest: receipt.after?.state === "observed" ? receipt.after.digest : null,
          beforeHead: receipt.before?.state === "observed" ? receipt.before.head : null,
          afterHead: receipt.after?.state === "observed" ? receipt.after.head : null,
        });
      }
      return {
        version: 1,
        state: "collected",
        collectedAt,
        sourceThreadId: threadId,
        currentValidity: "unknown",
        items,
        hasMore: rows.length > HANDOFF_TEST_RECEIPT_LIMIT,
      } satisfies HandoffTestEvidence;
    });
    const result = yield* collect.pipe(
      Effect.catch(() => Effect.succeed(unavailable("read_failed"))),
      Effect.timeoutOption("2 seconds"),
    );
    return Option.isSome(result) ? result.value : unavailable("timed_out");
  });
});
