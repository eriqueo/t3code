import { describe, expect, it } from "vite-plus/test";

import { shouldOfferStartFresh } from "./startFresh.ts";

describe("Start fresh offer", () => {
  const overnight = {
    snapshotCurrent: true,
    nowMs: Date.parse("2026-09-12T16:00:00.000Z"),
    latestMessageAt: "2026-09-12T07:59:59.999Z",
    usedTokens: 100_000,
    working: false,
    hasPendingRequest: false,
  };

  it("offers Start fresh on an expensive thread after an overnight pause", () => {
    expect(shouldOfferStartFresh(overnight)).toBe(true);
  });

  it.each([
    { snapshotCurrent: false },
    { working: true },
    { hasPendingRequest: true },
    { usedTokens: 99_999 },
    { usedTokens: null },
    { latestMessageAt: "2026-09-12T08:00:00.001Z" },
  ])("does not offer Start fresh below a threshold or while busy (%o)", (gate) => {
    expect(shouldOfferStartFresh({ ...overnight, ...gate })).toBe(false);
  });
});
