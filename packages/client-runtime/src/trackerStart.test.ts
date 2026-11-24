import { ProjectId, ProviderInstanceId, ThreadId, TrackerHubError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { routeStartFresh, trackerFailureText } from "./trackerStart.ts";

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const threadId = ThreadId.make("thread-1");
const newThreadId = ThreadId.make("thread-2");
const thread = {
  id: threadId,
  projectId: ProjectId.make("project-1"),
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "feature",
  worktreePath: "/repo/.worktrees/feature",
} as const;

describe("routeStartFresh", () => {
  it("asks the hub for a new agent, on the thread's model, when the thread owns a record", async () => {
    const ownerOf = vi.fn(async () => AsyncResult.success({ workId: "t3-tracker" }));
    const route = await routeStartFresh({
      trackerHub: true,
      thread,
      newThreadId,
      key: "press-1",
      ownerOf,
    });

    expect(ownerOf).toHaveBeenCalledWith({ threadId });
    expect(route).toEqual({
      _tag: "StartAgent",
      input: { workId: "t3-tracker", key: "press-1", model: modelSelection },
    });
  });

  it("opens an empty thread on the same model and workspace for a thread that owns no record, or a server with no hub", async () => {
    const expected = {
      _tag: "NewThread",
      input: {
        threadId: newThreadId,
        projectId: thread.projectId,
        title: "New thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "feature",
        worktreePath: "/repo/.worktrees/feature",
      },
    };
    const untracked = vi.fn(async () => AsyncResult.success({ workId: null }));
    expect(
      await routeStartFresh({
        trackerHub: true,
        thread,
        newThreadId,
        key: "k",
        ownerOf: untracked,
      }),
    ).toEqual(expected);

    const unasked = vi.fn(async () => AsyncResult.success({ workId: "t3-tracker" }));
    expect(
      await routeStartFresh({
        trackerHub: false,
        thread,
        newThreadId,
        key: "k",
        ownerOf: unasked,
      }),
    ).toEqual(expected);
    expect(unasked).not.toHaveBeenCalled();
  });

  it("starts nothing when the hub cannot say who owns the thread", async () => {
    const error = new TrackerHubError({
      reason: "unreachable",
      detail: "Could not reach the hub.",
    });
    const route = await routeStartFresh({
      trackerHub: true,
      thread,
      newThreadId,
      key: "k",
      ownerOf: async () => AsyncResult.failure(Cause.fail(error)),
    });

    expect(route._tag).toBe("OwnerUnknown");
    if (route._tag === "OwnerUnknown") {
      expect(trackerFailureText(route.failure)).toBe("Could not reach the hub.");
    }
  });
});
