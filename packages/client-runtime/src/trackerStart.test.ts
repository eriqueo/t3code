import { ProviderInstanceId, ThreadId, TrackerHubError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { routeStartFresh, trackerFailureText } from "./trackerStart.ts";

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const threadId = ThreadId.make("thread-1");

describe("routeStartFresh", () => {
  it("asks the hub for a new agent, on the thread's model, when the thread owns a record", async () => {
    const ownerOf = vi.fn(async () => AsyncResult.success({ workId: "t3-tracker" }));
    const route = await routeStartFresh({
      trackerHub: true,
      threadId,
      modelSelection,
      key: "press-1",
      ownerOf,
    });

    expect(ownerOf).toHaveBeenCalledWith({ threadId });
    expect(route).toEqual({
      _tag: "StartAgent",
      input: { workId: "t3-tracker", key: "press-1", model: modelSelection },
    });
  });

  it("keeps the context handoff for a thread that owns no record, or a server with no hub", async () => {
    const untracked = vi.fn(async () => AsyncResult.success({ workId: null }));
    expect(
      await routeStartFresh({
        trackerHub: true,
        threadId,
        modelSelection,
        key: "k",
        ownerOf: untracked,
      }),
    ).toEqual({ _tag: "Handoff" });

    const unasked = vi.fn(async () => AsyncResult.success({ workId: "t3-tracker" }));
    expect(
      await routeStartFresh({
        trackerHub: false,
        threadId,
        modelSelection,
        key: "k",
        ownerOf: unasked,
      }),
    ).toEqual({ _tag: "Handoff" });
    expect(unasked).not.toHaveBeenCalled();
  });

  it("starts nothing when the hub cannot say who owns the thread", async () => {
    const error = new TrackerHubError({
      reason: "unreachable",
      detail: "Could not reach the hub.",
    });
    const route = await routeStartFresh({
      trackerHub: true,
      threadId,
      modelSelection,
      key: "k",
      ownerOf: async () => AsyncResult.failure(Cause.fail(error)),
    });

    expect(route._tag).toBe("OwnerUnknown");
    if (route._tag === "OwnerUnknown") {
      expect(trackerFailureText(route.failure)).toBe("Could not reach the hub.");
    }
  });
});
