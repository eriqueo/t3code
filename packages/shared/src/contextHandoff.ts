import {
  THREAD_HANDOFF_ACTIVITY_KINDS,
  ThreadHandoffActivityPayload,
  type ThreadHandoffDismissedActivityPayload,
  type ThreadHandoffFailedActivityPayload,
  type ThreadHandoffReadyActivityPayload,
  type ThreadHandoffRequestedActivityPayload,
  type ThreadHandoffStartedActivityPayload,
  type MessageId,
  type OrchestrationThreadActivity,
  type OrchestrationSessionStatus,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

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
  readonly messages: ReadonlyArray<{
    readonly id: MessageId;
    readonly role: "user" | "assistant" | "system";
    readonly streaming: boolean;
  }>;
}): MessageId | null {
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (message?.role === "user" && !message.streaming) return message.id;
  }
  return null;
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
  readonly nowMs: number;
  readonly latestMessageAt: string | null;
  readonly usedTokens: number | null;
  readonly sessionStatus: OrchestrationSessionStatus | null;
  readonly latestTurnState: "running" | "interrupted" | "completed" | "error" | null;
  readonly hasPendingRequest: boolean;
  readonly handoffState: ThreadHandoffState["state"];
}): boolean {
  if (input.handoffState !== "none") return false;
  if (input.hasPendingRequest) return false;
  if (input.sessionStatus === "starting" || input.sessionStatus === "running") return false;
  if (input.latestTurnState === "running") return false;
  if ((input.usedTokens ?? 0) < THREAD_HANDOFF_MIN_USED_TOKENS) return false;

  const latestMessageAt = Date.parse(input.latestMessageAt ?? "");
  return (
    Number.isFinite(input.nowMs) &&
    Number.isFinite(latestMessageAt) &&
    input.nowMs - latestMessageAt >= THREAD_HANDOFF_IDLE_MS
  );
}
