import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { REVIEW_PROVIDER_INSTANCE_ID, type EnvironmentId } from "@t3tools/contracts";
import { shouldOfferStartFresh } from "@t3tools/shared/contextHandoff";
import type { ThreadStructure } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { routeStartFresh, trackerFailureText } from "@t3tools/client-runtime/tracker-start";
import * as DateTime from "effect/DateTime";
import { Minimize2Icon } from "lucide-react";
import { useRef, useState } from "react";
import { newThreadId, randomUUID } from "~/lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useTrackerAgentStart } from "../tracker/useTrackerAgentStart";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** Offers Start fresh on an expensive conversation that has sat idle. */
export function useCompactHandoff(input: {
  readonly environmentId: EnvironmentId;
  readonly projection: Pick<
    ThreadStructure,
    "thread" | "messages" | "runs" | "runtimeRequests"
  > | null;
  readonly snapshotCurrent: boolean;
  readonly nowMinute: string;
  readonly usedTokens: number | null;
}): ComposerBannerStackItem | null {
  const { environmentId, projection } = input;
  const navigate = useNavigate();
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const ownerOf = useAtomCommand(serverEnvironment.trackerThreadOwner, { reportFailure: false });
  const startAgent = useTrackerAgentStart();
  const trackerHub =
    useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities
      .trackerHub === true;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const source = projection?.messages.findLast(
    (message) => message.role === "user" && !message.streaming,
  );
  if (projection === null || source === undefined) return null;
  const { thread } = projection;
  const key = JSON.stringify([environmentId, thread.id, source.id]);
  // Decisions recorded before the transcript handoff retired still close the offer.
  const decided =
    thread.compactHandoff?.sourceMessageId === source.id &&
    (thread.compactHandoff.state === "dismissed" || thread.compactHandoff.state === "started");
  const working = projection.runs.some((run) =>
    ["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
  );
  const blocked = projection.runtimeRequests.some((request) => request.status === "pending");
  if (
    thread.providerInstanceId === REVIEW_PROVIDER_INSTANCE_ID ||
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    decided ||
    dismissed === key ||
    !shouldOfferStartFresh({
      snapshotCurrent: input.snapshotCurrent,
      nowMs: Date.parse(`${input.nowMinute}:00.000Z`),
      latestMessageAt: DateTime.formatIso(source.updatedAt),
      usedTokens: input.usedTokens,
      working,
      hasPendingRequest: blocked,
    })
  )
    return null;

  const startFresh = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const route = await routeStartFresh({
        trackerHub,
        thread,
        newThreadId: newThreadId(),
        key: randomUUID(),
        ownerOf: (ownerInput) => ownerOf({ environmentId, input: ownerInput }),
      });
      if (route._tag === "OwnerUnknown") {
        if (!isAtomCommandInterrupted(route.failure)) {
          toastManager.add({
            type: "error",
            title: "Could not check whether a tracker record follows this conversation",
            description: trackerFailureText(route.failure),
          });
        }
      } else if (route._tag === "StartAgent") {
        await startAgent(environmentId, route.input);
      } else {
        const created = await createThread({
          environmentId,
          input: { ...route.input, creationSource: "web" },
        });
        if (created._tag === "Success") {
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(environmentId, route.input.threadId)),
          });
        } else if (!isAtomCommandInterrupted(created)) {
          toastManager.add({ type: "error", title: "Could not start a new thread" });
        }
      }
    } catch {
      toastManager.add({ type: "error", title: "Could not start a new thread" });
    }
    busyRef.current = false;
    setBusy(false);
  };
  return {
    id: `start-fresh:${source.id}`,
    variant: "info",
    icon: <Minimize2Icon />,
    title: "Start a fresh conversation?",
    description:
      "This conversation is long and has been idle. A new one starts without its history",
    dismissLabel: "Keep full history",
    onDismiss: () => setDismissed(key),
    actions: (
      <Button size="sm" disabled={busy} onClick={() => void startFresh()}>
        Start fresh
      </Button>
    ),
  };
}
