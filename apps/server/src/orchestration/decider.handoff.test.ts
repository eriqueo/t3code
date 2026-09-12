import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-09-12T16:00:00.000Z";
const SOURCE = MessageId.make("message-source");
const REQUEST = CommandId.make("handoff-request");

function makeReadModel(activities: OrchestrationThread["activities"] = []): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [
      {
        id: ProjectId.make("project-1"),
        title: "Project",
        workspaceRoot: "/workspace",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        defaultThreadEnvMode: "local",
        autoPull: false,
        faviconPath: null,
        projectIcon: null,
        scripts: [],
        repositoryIdentity: null,
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Context harness",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "feature/handoff",
        worktreePath: "/workspace",
        pullRequests: [],
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        messages: [
          {
            id: SOURCE,
            role: "assistant",
            text: "Current state",
            turnId: null,
            streaming: false,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        proposedPlans: [],
        activities,
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("context handoff decider", (it) => {
  it.effect("reserves a source revision exactly once", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.handoff.prepare",
          commandId: REQUEST,
          threadId: ThreadId.make("thread-1"),
          sourceMessageId: SOURCE,
          createdAt: NOW,
        },
        readModel: makeReadModel(),
      });
      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("thread.activity-appended");
      if (event.type === "thread.activity-appended") {
        expect(event.payload.activity.kind).toBe("context-handoff.requested");
        expect(event.payload.activity.payload).toMatchObject({
          requestId: REQUEST,
          sourceMessageId: SOURCE,
          state: "requested",
        });
      }
    }),
  );

  it.effect("atomically archives the source and starts a fresh thread from a ready packet", () =>
    Effect.gen(function* () {
      const ready = {
        id: EventId.make("handoff-ready"),
        kind: "context-handoff.ready",
        summary: "Handoff ready",
        tone: "info" as const,
        turnId: null,
        createdAt: NOW,
        payload: {
          state: "ready",
          requestId: REQUEST,
          sourceMessageId: SOURCE,
          handoff: "# Operational handoff\n\n## Remaining work\n\nFinish it.",
          elapsedMs: 1,
          inputCharacters: 100,
          outputCharacters: 50,
        },
      } satisfies OrchestrationThread["activities"][number];
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.handoff.start",
          commandId: CommandId.make("start-handoff"),
          threadId: ThreadId.make("thread-1"),
          requestId: REQUEST,
          targetThreadId: ThreadId.make("thread-2"),
          createdAt: NOW,
        },
        readModel: makeReadModel([ready]),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual([
        "thread.activity-appended",
        "thread.archived",
        "thread.created",
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
      const message = events.find((event) => event.type === "thread.message-sent");
      expect(message?.payload.text).toContain("# Operational handoff");
      expect(message?.aggregateId).toBe(ThreadId.make("thread-2"));
    }),
  );

  it.effect("rejects a ready packet after the conversation changes", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.handoff.prepare",
          commandId: REQUEST,
          threadId: ThreadId.make("thread-1"),
          sourceMessageId: MessageId.make("older-message"),
          createdAt: NOW,
        },
        readModel: makeReadModel(),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
