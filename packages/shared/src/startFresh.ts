const START_FRESH_IDLE_MS = 8 * 60 * 60 * 1_000;
const START_FRESH_MIN_USED_TOKENS = 100_000;

/** Start fresh is offered on an expensive conversation that has sat idle overnight. */
export function shouldOfferStartFresh(input: {
  readonly snapshotCurrent: boolean;
  readonly nowMs: number;
  readonly latestMessageAt: string | null;
  readonly usedTokens: number | null;
  readonly working: boolean;
  readonly hasPendingRequest: boolean;
}): boolean {
  if (!input.snapshotCurrent || input.working || input.hasPendingRequest) return false;
  if ((input.usedTokens ?? 0) < START_FRESH_MIN_USED_TOKENS) return false;

  const latestMessageAt = Date.parse(input.latestMessageAt ?? "");
  return (
    Number.isFinite(input.nowMs) &&
    Number.isFinite(latestMessageAt) &&
    input.nowMs - latestMessageAt >= START_FRESH_IDLE_MS
  );
}
