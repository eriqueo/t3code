import { describe, expect, it } from "vite-plus/test";
import { CommandId, EventId, MessageId } from "@t3tools/contracts";

import {
  CONTEXT_CHECKPOINT_START_MARKER,
  CONTEXT_CHECKPOINT_END_MARKER,
  MAX_CONTEXT_CHECKPOINT_CHARACTERS,
  formatContextCheckpoint,
  parseContextCheckpoint,
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

describe("frontier context checkpoint envelope", () => {
  it("transfers Unicode, quotes, and body whitespace exactly", () => {
    const body = "\n# Checkpoint 🦊\n“Keep this quoted.”\n\nTrailing spaces  \n";
    const packet = formatContextCheckpoint(body);
    expect(packet).toBe(
      `${CONTEXT_CHECKPOINT_START_MARKER}\n${body}\n${CONTEXT_CHECKPOINT_END_MARKER}`,
    );
    expect(parseContextCheckpoint(packet)).toEqual({ state: "ready", body });
    expect(parseContextCheckpoint(` \n${packet}\n\t`)).toEqual({
      state: "ready",
      body,
    });
  });

  it.each([
    ["Correction: do not deploy.\n", ""],
    ["", "\nCorrection: tests failed after this checkpoint."],
  ])("rejects operational text outside the envelope (%j, %j)", (prefix, suffix) => {
    expect(
      parseContextCheckpoint(prefix + formatContextCheckpoint("Recorded state") + suffix),
    ).toEqual({ state: "invalid", reason: "malformed" });
  });

  it("leaves ordinary conversation outside the checkpoint protocol", () => {
    expect(parseContextCheckpoint("The t3-context-checkpoint formatter is available.")).toEqual({
      state: "none",
    });
  });

  it("accepts the UTF-16 body ceiling without truncation and rejects one unit beyond", () => {
    const body = "🦊".repeat(MAX_CONTEXT_CHECKPOINT_CHARACTERS / 2);
    expect(parseContextCheckpoint(formatContextCheckpoint(body))).toEqual({ state: "ready", body });
    expect(() => formatContextCheckpoint(body + "x")).toThrow(RangeError);
    expect(
      parseContextCheckpoint(
        `${CONTEXT_CHECKPOINT_START_MARKER}\n${body}x\n${CONTEXT_CHECKPOINT_END_MARKER}`,
      ),
    ).toEqual({ state: "invalid", reason: "oversized" });
  });

  it.each(["", " \n\t"])("rejects an empty or whitespace-only body (%j)", (body) => {
    expect(() => formatContextCheckpoint(body)).toThrow(RangeError);
    expect(
      parseContextCheckpoint(
        `${CONTEXT_CHECKPOINT_START_MARKER}\n${body}\n${CONTEXT_CHECKPOINT_END_MARKER}`,
      ),
    ).toEqual({ state: "invalid", reason: "empty" });
  });

  it("rejects unknown protocol versions", () => {
    expect(parseContextCheckpoint(formatContextCheckpoint("State").replace(":v1", ":v2"))).toEqual({
      state: "invalid",
      reason: "unsupported_version",
    });
  });

  it.each([
    CONTEXT_CHECKPOINT_START_MARKER + "\nMissing close",
    "Missing open\n" + CONTEXT_CHECKPOINT_END_MARKER,
    CONTEXT_CHECKPOINT_END_MARKER + "\nReversed\n" + CONTEXT_CHECKPOINT_START_MARKER,
    CONTEXT_CHECKPOINT_START_MARKER + "Missing framing newline\n" + CONTEXT_CHECKPOINT_END_MARKER,
    CONTEXT_CHECKPOINT_START_MARKER + "\nMissing framing newline" + CONTEXT_CHECKPOINT_END_MARKER,
    CONTEXT_CHECKPOINT_START_MARKER.replace("-->", "") +
      "\nBroken\n" +
      CONTEXT_CHECKPOINT_END_MARKER,
  ])("rejects malformed checkpoint envelopes (%j)", (packet) => {
    expect(parseContextCheckpoint(packet)).toEqual({ state: "invalid", reason: "malformed" });
  });

  it("rejects nested or repeated markers instead of choosing a body", () => {
    const packet = formatContextCheckpoint("State");
    expect(parseContextCheckpoint(`${packet}\n${packet}`)).toEqual({
      state: "invalid",
      reason: "nested_markers",
    });
    expect(
      parseContextCheckpoint(
        `${CONTEXT_CHECKPOINT_START_MARKER}\n${packet}\n${CONTEXT_CHECKPOINT_END_MARKER}`,
      ),
    ).toEqual({ state: "invalid", reason: "nested_markers" });
    expect(() => formatContextCheckpoint(packet)).toThrow(RangeError);
  });
});
