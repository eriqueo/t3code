import {
  isImportedAgentSessionMessageId,
  THREAD_HANDOFF_ACTIVITY_KINDS,
  ThreadHandoffActivityPayload,
  type ThreadHandoffDismissedActivityPayload,
  type ThreadHandoffFailedActivityPayload,
  type ThreadHandoffReadyActivityPayload,
  type ThreadHandoffRequestedActivityPayload,
  type ThreadHandoffStartedActivityPayload,
  type MessageId,
  type OrchestrationThreadShell,
  type OrchestrationThreadActivity,
  type OrchestrationSessionStatus,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const CONTEXT_CHECKPOINT_VERSION = 1;
const CONTEXT_CHECKPOINT_MARKER_NAME = "t3-context-checkpoint";
export const CONTEXT_CHECKPOINT_START_MARKER = `<!-- ${CONTEXT_CHECKPOINT_MARKER_NAME}:v${CONTEXT_CHECKPOINT_VERSION} -->`;
export const CONTEXT_CHECKPOINT_END_MARKER = `<!-- /${CONTEXT_CHECKPOINT_MARKER_NAME} -->`;
export const MAX_CONTEXT_CHECKPOINT_CHARACTERS = 12_000;

export type ContextCheckpointResult =
  | { readonly state: "none" }
  | {
      readonly state: "invalid";
      readonly reason:
        | "malformed"
        | "unsupported_version"
        | "oversized"
        | "nested_markers"
        | "empty";
    }
  | { readonly state: "ready"; readonly body: string };

/** Validates the envelope only; the author owns the checkpoint's semantic accuracy. */
export function parseContextCheckpoint(text: string): ContextCheckpointResult {
  const markers = [
    ...text.matchAll(new RegExp(`<!--\\s*\\/?\\s*${CONTEXT_CHECKPOINT_MARKER_NAME}\\b`, "g")),
  ];
  if (markers.length === 0) return { state: "none" };
  if (markers.length > 2) return { state: "invalid", reason: "nested_markers" };
  if (markers.length !== 2) return { state: "invalid", reason: "malformed" };
  const start = markers[0]!.index;
  const end = markers[1]!.index;
  const opening = text.slice(start);
  const version = new RegExp(`^<!-- ${CONTEXT_CHECKPOINT_MARKER_NAME}:v([^\\s>]+) -->`).exec(
    opening,
  )?.[1];
  if (version !== undefined && version !== String(CONTEXT_CHECKPOINT_VERSION)) {
    return { state: "invalid", reason: "unsupported_version" };
  }
  if (
    !opening.startsWith(CONTEXT_CHECKPOINT_START_MARKER + "\n") ||
    !text.startsWith(CONTEXT_CHECKPOINT_END_MARKER, end) ||
    text[end - 1] !== "\n" ||
    text.slice(0, start).trim().length > 0 ||
    text.slice(end + CONTEXT_CHECKPOINT_END_MARKER.length).trim().length > 0
  ) {
    return { state: "invalid", reason: "malformed" };
  }
  // Remove exactly the formatter's two LF separators, never trim the body.
  const body = text.slice(start + CONTEXT_CHECKPOINT_START_MARKER.length + 1, end - 1);
  if (body.length > MAX_CONTEXT_CHECKPOINT_CHARACTERS)
    return { state: "invalid", reason: "oversized" };
  if (!body.trim()) return { state: "invalid", reason: "empty" };
  return { state: "ready", body };
}

/** Never search past a newer user, system, empty, or streaming message. */
export function latestContextCheckpoint(
  messages: ReadonlyArray<{
    readonly role: "user" | "assistant" | "system";
    readonly streaming: boolean;
    readonly text: string;
  }>,
): ContextCheckpointResult {
  const latest = messages.at(-1);
  return latest?.role === "assistant" && !latest.streaming
    ? parseContextCheckpoint(latest.text)
    : { state: "none" };
}

/** Emits one canonical envelope without truncating or normalizing the supplied Markdown. */
export function formatContextCheckpoint(body: string): string {
  const packet = `${CONTEXT_CHECKPOINT_START_MARKER}\n${body}\n${CONTEXT_CHECKPOINT_END_MARKER}`;
  const parsed = parseContextCheckpoint(packet);
  if (parsed.state !== "ready") {
    throw new RangeError(
      `Invalid context checkpoint: ${parsed.state === "invalid" ? parsed.reason : "malformed"}`,
    );
  }
  return packet;
}

export const THREAD_HANDOFF_IDLE_MS = 8 * 60 * 60 * 1_000;
export const THREAD_HANDOFF_MIN_USED_TOKENS = 100_000;

export type ThreadHandoffState =
  | { readonly state: "none" }
  | { readonly state: "requested"; readonly payload: ThreadHandoffRequestedActivityPayload }
  | { readonly state: "ready"; readonly payload: ThreadHandoffReadyActivityPayload }
  | { readonly state: "failed"; readonly payload: ThreadHandoffFailedActivityPayload }
  | { readonly state: "dismissed"; readonly payload: ThreadHandoffDismissedActivityPayload }
  | { readonly state: "started"; readonly payload: ThreadHandoffStartedActivityPayload };

const isThreadHandoffActivityPayload = Schema.is(ThreadHandoffActivityPayload);
const handoffKinds = new Set<string>(Object.values(THREAD_HANDOFF_ACTIVITY_KINDS));

export function latestThreadUserMessageId(input: {
  readonly latestUserMessageId?: MessageId | null | undefined;
  readonly messages: ReadonlyArray<{
    readonly id: MessageId;
    readonly role: "user" | "assistant" | "system";
    readonly streaming: boolean;
  }>;
}): MessageId | null {
  if (input.latestUserMessageId !== undefined) return input.latestUserMessageId;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (
      message?.role === "user" &&
      !message.streaming &&
      !isImportedAgentSessionMessageId(message.id)
    )
      return message.id;
  }
  return null;
}

export function threadHandoffSourceMessageId(
  shell: Pick<OrchestrationThreadShell, "latestUserMessageId"> | null | undefined,
): MessageId | null {
  return shell?.latestUserMessageId ?? null;
}

export function deriveThreadHandoffState(
  activities: ReadonlyArray<Pick<OrchestrationThreadActivity, "kind" | "payload">>,
  sourceMessageId: MessageId,
): ThreadHandoffState {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || !handoffKinds.has(activity.kind)) continue;
    if (!isThreadHandoffActivityPayload(activity.payload)) continue;
    if (activity.payload.sourceMessageId !== sourceMessageId) continue;
    return { state: activity.payload.state, payload: activity.payload } as ThreadHandoffState;
  }
  return { state: "none" };
}

export function shouldPrepareThreadHandoff(input: {
  readonly snapshotCurrent: boolean;
  readonly hasExplicitCheckpoint?: boolean;
  readonly nowMs: number;
  readonly latestMessageAt: string | null;
  readonly usedTokens: number | null;
  readonly sessionStatus: OrchestrationSessionStatus | null;
  readonly latestTurnState: "running" | "interrupted" | "completed" | "error" | null;
  readonly hasPendingRequest: boolean;
  readonly handoffState: ThreadHandoffState["state"];
}): boolean {
  if (!input.snapshotCurrent) return false;
  if (input.handoffState !== "none") return false;
  if (input.hasPendingRequest) return false;
  if (input.sessionStatus === "starting" || input.sessionStatus === "running") return false;
  if (input.latestTurnState === "running") return false;
  // An explicit frontier checkpoint is ready for transfer immediately after the
  // turn settles; age and token thresholds apply only to automatic excerpts.
  if (input.hasExplicitCheckpoint === true) return true;
  if ((input.usedTokens ?? 0) < THREAD_HANDOFF_MIN_USED_TOKENS) return false;

  const latestMessageAt = Date.parse(input.latestMessageAt ?? "");
  return (
    Number.isFinite(input.nowMs) &&
    Number.isFinite(latestMessageAt) &&
    input.nowMs - latestMessageAt >= THREAD_HANDOFF_IDLE_MS
  );
}
