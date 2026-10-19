import * as Schema from "effect/Schema";
import {
  CommandId,
  MessageId,
  ThreadId,
  IsoDateTime,
  TrimmedNonEmptyString,
  NonNegativeInt,
} from "./baseSchemas.ts";
import { HandoffTestEvidence } from "./testRuns.ts";
import { HandoffRuntimeObservation } from "./runtimeObservation.ts";

export const THREAD_HANDOFF_ACTIVITY_KINDS = {
  requested: "context-handoff.requested",
  ready: "context-handoff.ready",
  failed: "context-handoff.failed",
  dismissed: "context-handoff.dismissed",
  started: "context-handoff.started",
} as const;

const ThreadHandoffActivityBase = {
  requestId: CommandId,
  sourceMessageId: MessageId,
} as const;

export const ThreadHandoffRequestedActivityPayload = Schema.Struct({
  ...ThreadHandoffActivityBase,
  state: Schema.Literal("requested"),
});
export type ThreadHandoffRequestedActivityPayload =
  typeof ThreadHandoffRequestedActivityPayload.Type;

const HandoffWorkspaceObservationBase = {
  version: Schema.Literal(1),
  startedAt: IsoDateTime,
  completedAt: IsoDateTime,
};
// CRITICAL: retained with the parent ready activity; no independent store or history.
// The digest identifies porcelain status, not file contents or test validity.
export const HandoffWorkspaceObservation = Schema.Union([
  Schema.Struct({
    ...HandoffWorkspaceObservationBase,
    state: Schema.Literal("observed"),
    cwd: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
    commonDirectory: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
    branch: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(1_024))),
    head: Schema.NullOr(Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/))),
    dirty: Schema.Boolean,
    statusDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  }),
  Schema.Struct({
    ...HandoffWorkspaceObservationBase,
    state: Schema.Literal("unavailable"),
    code: Schema.Literals([
      "invalid_checkout",
      "inspection_failed",
      "changed_during_observation",
      "timed_out",
    ]),
  }),
]);
export type HandoffWorkspaceObservation = typeof HandoffWorkspaceObservation.Type;

export const ThreadHandoffReadyActivityPayload = Schema.Struct({
  ...ThreadHandoffActivityBase,
  state: Schema.Literal("ready"),
  handoff: TrimmedNonEmptyString.check(Schema.isMaxLength(16_384)),
  elapsedMs: NonNegativeInt,
  inputCharacters: NonNegativeInt,
  outputCharacters: NonNegativeInt,
  // Optional permanently: persisted activities from earlier builds have no observation.
  workspaceObservation: Schema.optional(HandoffWorkspaceObservation),
  testEvidence: Schema.optional(HandoffTestEvidence),
  runtimeObservation: Schema.optional(HandoffRuntimeObservation),
});
export type ThreadHandoffReadyActivityPayload = typeof ThreadHandoffReadyActivityPayload.Type;

export const ThreadHandoffFailedActivityPayload = Schema.Struct({
  ...ThreadHandoffActivityBase,
  state: Schema.Literal("failed"),
  code: TrimmedNonEmptyString,
  detail: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
});
export type ThreadHandoffFailedActivityPayload = typeof ThreadHandoffFailedActivityPayload.Type;

export const ThreadHandoffDismissedActivityPayload = Schema.Struct({
  ...ThreadHandoffActivityBase,
  state: Schema.Literal("dismissed"),
});
export type ThreadHandoffDismissedActivityPayload =
  typeof ThreadHandoffDismissedActivityPayload.Type;

export const ThreadHandoffStartedActivityPayload = Schema.Struct({
  ...ThreadHandoffActivityBase,
  state: Schema.Literal("started"),
  targetThreadId: ThreadId,
});
export type ThreadHandoffStartedActivityPayload = typeof ThreadHandoffStartedActivityPayload.Type;

export const ThreadHandoffActivityPayload = Schema.Union([
  ThreadHandoffRequestedActivityPayload,
  ThreadHandoffReadyActivityPayload,
  ThreadHandoffFailedActivityPayload,
  ThreadHandoffDismissedActivityPayload,
  ThreadHandoffStartedActivityPayload,
]);
export type ThreadHandoffActivityPayload = typeof ThreadHandoffActivityPayload.Type;
