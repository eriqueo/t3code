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

function makeReadModel(
  activities: OrchestrationThread["activities"] = [],
  options?: { readonly commandSnapshot?: boolean },
): OrchestrationReadModel {
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
        ...(options?.commandSnapshot ? { latestUserMessageId: SOURCE } : {}),
        messages: options?.commandSnapshot
          ? []
          : [
              {
                id: SOURCE,
                role: "user",
                text: "Please finish the current task",
                turnId: null,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
              {
                id: MessageId.make("assistant-response"),
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
        readModel: makeReadModel([], { commandSnapshot: true }),
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
      expect(events.filter((event) => event.type === "thread.message-sent")).toHaveLength(1);
      expect(message?.payload.text).not.toContain("Please finish the current task");
      expect(message?.payload.text).not.toContain("Current state");
      expect(message?.payload.text.endsWith(ready.payload.handoff)).toBe(true);

      const changed = makeReadModel([ready], { commandSnapshot: true });
      const thread = changed.threads[0]!;
      for (const readModel of [
        makeReadModel([{ ...ready, payload: { ...ready.payload, requestId: "replacement" } }]),
        {
          ...changed,
          threads: [{ ...thread, latestUserMessageId: MessageId.make("new-user-message") }],
        },
      ]) {
        const error = yield* decideOrchestrationCommand({
          command: {
            type: "thread.handoff.start",
            commandId: CommandId.make("stale-start"),
            threadId: ThreadId.make("thread-1"),
            requestId: REQUEST,
            targetThreadId: ThreadId.make("stale-target"),
            createdAt: NOW,
          },
          readModel,
        }).pipe(Effect.flip);
        expect(error._tag).toBe("OrchestrationCommandInvariantError");
      }
    }),
  );

  it.effect("rejects preparation for an older conversation revision", () =>
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

  it.effect(
    "explicitly regenerates a ready report but rejects duplicate in-flight regeneration",
    () =>
      Effect.gen(function* () {
        const ready: OrchestrationThread["activities"][number] = {
          id: EventId.make("ready-for-regeneration"),
          kind: "context-handoff.ready",
          summary: "Ready",
          tone: "info",
          turnId: null,
          createdAt: NOW,
          payload: {
            state: "ready",
            requestId: REQUEST,
            sourceMessageId: SOURCE,
            handoff: "Old report",
            elapsedMs: 1,
            inputCharacters: 10,
            outputCharacters: 10,
          },
        };
        const command = {
          type: "thread.handoff.prepare" as const,
          commandId: CommandId.make("regenerate-report"),
          threadId: ThreadId.make("thread-1"),
          sourceMessageId: SOURCE,
          retry: true as const,
          createdAt: NOW,
        };
        const result = yield* decideOrchestrationCommand({
          command,
          readModel: makeReadModel([ready]),
        });
        const event = Array.isArray(result) ? result[0] : result;
        expect(event.type).toBe("thread.activity-appended");
        if (event.type !== "thread.activity-appended") return;
        expect(event.payload.activity.payload).toMatchObject({
          state: "requested",
          requestId: command.commandId,
        });
        const error = yield* decideOrchestrationCommand({
          command: { ...command, commandId: CommandId.make("duplicate-regeneration") },
          readModel: makeReadModel([ready, event.payload.activity]),
        }).pipe(Effect.flip);
        expect(error._tag).toBe("OrchestrationCommandInvariantError");
        const staleStart = yield* decideOrchestrationCommand({
          command: {
            type: "thread.handoff.start",
            commandId: CommandId.make("start-replaced-report"),
            threadId: ThreadId.make("thread-1"),
            requestId: REQUEST,
            targetThreadId: ThreadId.make("stale-target"),
            createdAt: NOW,
          },
          readModel: makeReadModel([ready, event.payload.activity]),
        }).pipe(Effect.flip);
        expect(staleStart._tag).toBe("OrchestrationCommandInvariantError");
      }),
  );
});
