import { describe, expect, it } from "vite-plus/test";
import { CommandId, EventId, MessageId } from "@t3tools/contracts";

import {
  deriveThreadHandoffState,
  latestThreadUserMessageId,
  threadHandoffSourceMessageId,
  shouldPrepareThreadHandoff,
} from "./contextHandoff.ts";

const SOURCE_MESSAGE_ID = MessageId.make("message-2");

describe("context handoff policy", () => {
  it("offers one handoff for an expensive thread after an overnight pause", () => {
    expect(
      shouldPrepareThreadHandoff({
        snapshotCurrent: true,
        nowMs: Date.parse("2026-09-12T16:00:00.000Z"),
        latestMessageAt: "2026-09-12T07:59:59.999Z",
        usedTokens: 100_000,
        sessionStatus: "idle",
        latestTurnState: "completed",
        hasPendingRequest: false,
        handoffState: "none",
      }),
    ).toBe(true);
  });

  it("waits for the thread snapshot to synchronize before requesting a handoff", () => {
    expect(
      shouldPrepareThreadHandoff({
        nowMs: Date.parse("2026-09-12T16:00:00.000Z"),
        latestMessageAt: "2026-09-12T07:59:59.999Z",
        usedTokens: 100_000,
        sessionStatus: "idle",
        latestTurnState: "completed",
        hasPendingRequest: false,
        handoffState: "none",
        snapshotCurrent: false,
      }),
    ).toBe(false);
  });

  it.each([
    { usedTokens: 99_999, latestMessageAt: "2026-09-12T07:00:00.000Z", handoffState: "none" },
    { usedTokens: 100_000, latestMessageAt: "2026-09-12T08:00:00.001Z", handoffState: "none" },
    { usedTokens: 100_000, latestMessageAt: "2026-09-12T07:00:00.000Z", handoffState: "ready" },
  ] as const)("does not repeat or prepare below a threshold (%o)", (sample) => {
    expect(
      shouldPrepareThreadHandoff({
        snapshotCurrent: true,
        nowMs: Date.parse("2026-09-12T16:00:00.000Z"),
        latestMessageAt: sample.latestMessageAt,
        usedTokens: sample.usedTokens,
        sessionStatus: "idle",
        latestTurnState: "completed",
        hasPendingRequest: false,
        handoffState: sample.handoffState,
      }),
    ).toBe(false);
  });

  it("uses the latest non-streaming user message as the source revision", () => {
    expect(
      latestThreadUserMessageId({
        messages: [
          { id: MessageId.make("message-1"), role: "user", streaming: false },
          { id: SOURCE_MESSAGE_ID, role: "user", streaming: false },
          { id: MessageId.make("assistant-final"), role: "assistant", streaming: false },
          { id: MessageId.make("import:codex:newer"), role: "user", streaming: false },
          { id: MessageId.make("message-streaming"), role: "user", streaming: true },
        ],
      }),
    ).toBe(SOURCE_MESSAGE_ID);
  });

  it("uses the authoritative shell revision for client handoffs", () => {
    expect(threadHandoffSourceMessageId({ latestUserMessageId: SOURCE_MESSAGE_ID })).toBe(
      SOURCE_MESSAGE_ID,
    );
    expect(threadHandoffSourceMessageId({})).toBeNull();
  });

  it("uses an authoritative revision when a command snapshot omits message bodies", () => {
    expect(
      latestThreadUserMessageId({ latestUserMessageId: SOURCE_MESSAGE_ID, messages: [] }),
    ).toBe(SOURCE_MESSAGE_ID);
    expect(
      latestThreadUserMessageId({
        latestUserMessageId: null,
        messages: [{ id: SOURCE_MESSAGE_ID, role: "user", streaming: false }],
      }),
    ).toBeNull();
  });

  it("selects the latest terminal activity for the current source revision", () => {
    const requestId = CommandId.make("request-1");
    const base = {
      id: EventId.make("event-1"),
      tone: "info" as const,
      summary: "Preparing a compact handoff",
      turnId: null,
      createdAt: "2026-09-12T08:00:00.000Z",
    };
    const activities = [
      {
        ...base,
        kind: "context-handoff.requested",
        payload: { state: "requested", requestId, sourceMessageId: SOURCE_MESSAGE_ID },
      },
      {
        ...base,
        id: EventId.make("event-2"),
        kind: "context-handoff.ready",
        payload: {
          state: "ready",
          requestId,
          sourceMessageId: SOURCE_MESSAGE_ID,
          handoff: "## Current state\nReady.",
          elapsedMs: 84_000,
          inputCharacters: 5_000,
          outputCharacters: 512,
        },
      },
    ];

    expect(deriveThreadHandoffState(activities, SOURCE_MESSAGE_ID).state).toBe("ready");
  });
});
