import * as Schema from "effect/Schema";
import { IsoDateTime, ThreadId, NonNegativeInt } from "./baseSchemas.ts";

const TEST_RUN_MAX_SECONDS = 600;
const Id = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/));
const Argument = Schema.String.check(Schema.isMaxLength(4096), Schema.isPattern(/^[^\0]*$/));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Path = Schema.String.check(Schema.isMaxLength(4096));
export const TestRunInput = Schema.Struct({
  version: Schema.Literal(1),
  requestId: Id,
  threadId: ThreadId,
  command: Argument.check(Schema.isNonEmpty()),
  args: Schema.Array(Argument).check(Schema.isMaxLength(64)),
  timeoutSeconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: TEST_RUN_MAX_SECONDS })),
});
export type TestRunInput = typeof TestRunInput.Type;
export const TestRunLookup = Schema.Struct({ requestId: Id });
export const TestRunRelease = Schema.Struct({
  requestId: Id,
  processStopped: Schema.Literal(true),
});
export type TestRunRelease = typeof TestRunRelease.Type;
export const TestWorkspaceFingerprint = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("observed"),
    version: Schema.Literal(1),
    capturedAt: IsoDateTime,
    cwd: Path,
    commonDirectory: Path,
    branch: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1024))),
    dirty: Schema.Boolean,
    statusDigest: Digest,
    head: Schema.NullOr(Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/))),
    digest: Digest,
    fileCount: NonNegativeInt,
    bytes: NonNegativeInt,
    scope: Schema.Literal("tracked_and_nonignored_untracked"),
  }),
  Schema.Struct({
    state: Schema.Literal("unavailable"),
    version: Schema.Literal(1),
    capturedAt: IsoDateTime,
    code: Schema.Literals([
      "inspection_failed",
      "limit_exceeded",
      "unsupported_file",
      "changed_during_observation",
      "timed_out",
    ]),
  }),
]);
export type TestWorkspaceFingerprint = typeof TestWorkspaceFingerprint.Type;
export const TestRunReceipt = Schema.Struct({
  version: Schema.Literal(1),
  input: TestRunInput,
  actorSessionId: Schema.String.check(Schema.isMaxLength(256)),
  cwd: Path,
  reservedAt: IsoDateTime,
  deadlineAt: IsoDateTime,
  state: Schema.Literals(["running", "completed", "not_started", "outcome_unknown"]),
  startedAt: Schema.NullOr(IsoDateTime),
  exitedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  exitCode: Schema.NullOr(Schema.Int),
  reason: Schema.NullOr(
    Schema.Literals([
      "fingerprint_unavailable",
      "execution_failed",
      "timed_out",
      "interrupted",
      "deadline_elapsed",
    ]),
  ),
  before: Schema.NullOr(TestWorkspaceFingerprint),
  after: Schema.NullOr(TestWorkspaceFingerprint),
  revisionValidity: Schema.Literals(["matching_observations", "changed", "unknown"]),
  releasedBy: Schema.NullOr(Schema.String.check(Schema.isMaxLength(256))),
});
export type TestRunReceipt = typeof TestRunReceipt.Type;
export class TestRunError extends Schema.TaggedError<TestRunError>()(
  "TestRunError",
  {
    code: Schema.Literals([
      "thread_missing",
      "invalid_checkout",
      "request_missing",
      "request_conflict",
      "workspace_busy",
      "still_running",
      "storage_failed",
    ]),
  },
  { httpApiStatus: 409 },
) {
  override get message() {
    return `Test run failed (${this.code}).`;
  }
}
