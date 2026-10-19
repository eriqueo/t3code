import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import {
  CommandId,
  REVIEW_PROVIDER_INSTANCE_ID,
  type EnvironmentId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import {
  latestContextCheckpoint,
  shouldPrepareThreadHandoff,
} from "@t3tools/shared/contextHandoff";
import type { ThreadHandoffCommand } from "@t3tools/client-runtime/state/threads";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import * as DateTime from "effect/DateTime";
import { Minimize2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { newThreadId, randomUUID } from "~/lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

export function useCompactHandoff(input: {
  readonly environmentId: EnvironmentId;
  readonly projection: OrchestrationV2ThreadProjection | null;
  readonly supported: boolean;
  readonly snapshotCurrent: boolean;
  readonly nowMinute: string;
  readonly usedTokens: number | null;
}): ComposerBannerStackItem | null {
  const { environmentId, projection } = input;
  const navigate = useNavigate();
  const canOperate = useAtomValue(threadEnvironment.handoff.permissionAtom(environmentId));
  const dispatch = useAtomCommand(threadEnvironment.handoff, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const requested = useRef(new Set<string>());
  const source = projection?.messages.findLast(
    (message) => message.role === "user" && !message.streaming,
  );
  const current = projection?.thread.compactHandoff;
  const state = current?.sourceMessageId === source?.id ? current : null;
  const available =
    input.supported &&
    canOperate &&
    projection !== null &&
    projection.thread.providerInstanceId !== REVIEW_PROVIDER_INSTANCE_ID &&
    projection.thread.archivedAt === null &&
    projection.thread.deletedAt === null;
  const working =
    projection?.runs.some((run) =>
      ["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
    ) === true;
  const blocked =
    projection?.runtimeRequests.some((request) => request.status === "pending") === true;

  useEffect(() => {
    if (!available || projection === null || source === undefined) return;
    const key = JSON.stringify([environmentId, projection.thread.id, source.id]);
    if (
      requested.current.has(key) ||
      !shouldPrepareThreadHandoff({
        snapshotCurrent: input.snapshotCurrent,
        hasExplicitCheckpoint: latestContextCheckpoint(projection.messages).state !== "none",
        nowMs: Date.parse(`${input.nowMinute}:00.000Z`),
        latestMessageAt: DateTime.formatIso(source.updatedAt),
        usedTokens: input.usedTokens,
        sessionStatus: working ? "running" : "idle",
        latestTurnState: working ? "running" : "completed",
        hasPendingRequest: blocked,
        handoffState: state?.state ?? "none",
      })
    )
      return;
    // AUTO-MANAGED: retain at most 128 revision keys; evict the oldest at the
    // limit. The server's durable decision remains the deduplication authority.
    if (requested.current.size >= 128)
      requested.current.delete(requested.current.values().next().value!);
    requested.current.add(key);
    void dispatch({
      environmentId,
      input: {
        type: "thread.handoff.prepare",
        commandId: CommandId.make(randomUUID()),
        threadId: projection.thread.id,
        sourceMessageId: source.id,
      },
    }).then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        requested.current.delete(key);
        toastManager.add({ type: "error", title: "Could not request a handoff" });
      }
    });
  }, [
    available,
    blocked,
    dispatch,
    environmentId,
    input.nowMinute,
    input.snapshotCurrent,
    input.usedTokens,
    projection,
    source,
    state?.state,
    working,
  ]);

  const act = async (command: ThreadHandoffCommand) => {
    if (busyRef.current || !canOperate) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await dispatch({ environmentId, input: command });
      if (result._tag === "Success" && command.type === "thread.handoff.start") {
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(environmentId, command.targetThreadId)),
        });
      } else if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        toastManager.add({ type: "error", title: "Could not update the handoff" });
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  if (
    !available ||
    !state ||
    !source ||
    !projection ||
    state.state === "dismissed" ||
    state.state === "started"
  )
    return null;
  const threadId = projection.thread.id;
  const dismiss = () =>
    void act({
      type: "thread.handoff.dismiss",
      commandId: CommandId.make(randomUUID()),
      threadId,
      sourceMessageId: source.id,
    });
  const retry = () =>
    void act({
      type: "thread.handoff.prepare",
      commandId: CommandId.make(randomUUID()),
      threadId,
      sourceMessageId: source.id,
      retry: true,
    });
  const disabled = busy || working || blocked || !input.snapshotCurrent;
  return {
    id: `context-handoff:${state.requestId}`,
    variant: state.state === "failed" ? "error" : "info",
    icon: <Minimize2Icon />,
    title:
      state.state === "requested"
        ? "Preparing context handoff"
        : state.state === "failed"
          ? "Could not prepare the handoff"
          : "Fresh-conversation handoff ready",
    description:
      state.state === "requested"
        ? "You can keep working here while it runs"
        : state.state === "failed"
          ? state.detail
          : "Start with compact operational memory instead of replaying this full thread",
    dismissLabel: "Keep full history",
    onDismiss: dismiss,
    ...(state.state === "requested"
      ? {}
      : {
          actions: (
            <>
              <Button size="sm" variant="ghost" disabled={disabled} onClick={retry}>
                {state.state === "failed" ? "Retry" : "Regenerate"}
              </Button>
              {state.state === "ready" && (
                <Button
                  size="sm"
                  disabled={disabled}
                  onClick={() =>
                    void act({
                      type: "thread.handoff.start",
                      commandId: CommandId.make(randomUUID()),
                      threadId,
                      requestId: state.requestId,
                      targetThreadId: newThreadId(),
                      createdBy: "user",
                      creationSource: "web",
                    })
                  }
                >
                  Start fresh
                </Button>
              )}
            </>
          ),
        }),
  };
}
