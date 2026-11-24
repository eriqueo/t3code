import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import {
  ThreadId,
  REVIEW_PROVIDER_INSTANCE_ID,
  type EnvironmentId,
  type OrchestrationV2ThreadProjection,
  type TrackerStartAgentInput,
} from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import {
  agentStillStartingText,
  routeStartFresh,
  trackerFailureText,
} from "@t3tools/client-runtime/tracker-start";
import { shouldOfferStartFresh } from "@t3tools/shared/contextHandoff";
import * as DateTime from "effect/DateTime";
import { useRef, useState } from "react";
import { View } from "react-native";
import { Notice } from "../../components/ui/Notice";
import { Button } from "../../components/ui/Button";
import { useNowMinuteMs } from "../../lib/clock";
import { uuidv4 } from "../../lib/uuid";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

/** Offers Start fresh on an expensive conversation that has sat idle. */
export function CompactHandoffCard(props: {
  readonly environmentId: EnvironmentId;
  readonly projection: OrchestrationV2ThreadProjection | null;
  readonly snapshotCurrent: boolean;
}) {
  const { projection, environmentId } = props;
  const navigation = useNavigation();
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const ownerOf = useAtomCommand(serverEnvironment.trackerThreadOwner, { reportFailure: false });
  const startAgent = useAtomCommand(serverEnvironment.trackerStartAgent, { reportFailure: false });
  const trackerHub =
    useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities
      .trackerHub === true;
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const nowMs = useNowMinuteMs();
  const source = projection?.messages.findLast(
    (message) => message.role === "user" && !message.streaming,
  );
  if (!projection || !source) return null;
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
  const usage = projection.providerTurns
    .flatMap((turn) => (turn.tokenUsage ? [turn.tokenUsage] : []))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  const activeProvider = projection.providerThreads.find(
    (providerThread) => providerThread.id === thread.activeProviderThreadId,
  );
  const offered =
    thread.providerInstanceId !== REVIEW_PROVIDER_INSTANCE_ID &&
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    !decided &&
    dismissed !== key &&
    shouldOfferStartFresh({
      snapshotCurrent: props.snapshotCurrent,
      nowMs,
      latestMessageAt: DateTime.formatIso(source.updatedAt),
      usedTokens: usage?.usedTokens ?? activeProvider?.contextUsage?.usedTokens ?? null,
      working,
      hasPendingRequest: blocked,
    });

  const openThread = (threadId: string) =>
    navigation.dispatch(
      StackActions.replace("Thread", { environmentId: String(environmentId), threadId }),
    );
  const startTrackedAgent = async (input: TrackerStartAgentInput) => {
    const started = await startAgent({ environmentId, input });
    if (started._tag === "Failure") {
      if (!isAtomCommandInterrupted(started)) setError(trackerFailureText(started));
    } else if (started.value.threadId === null) {
      setStarting(agentStillStartingText(started.value.host));
    } else {
      openThread(started.value.threadId);
    }
  };
  const startFresh = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const route = await routeStartFresh({
        trackerHub,
        thread,
        newThreadId: ThreadId.make(uuidv4()),
        key: uuidv4(),
        ownerOf: (ownerInput) => ownerOf({ environmentId, input: ownerInput }),
      });
      if (route._tag === "OwnerUnknown") {
        if (!isAtomCommandInterrupted(route.failure)) {
          setError(
            `Could not check whether a tracker record follows this conversation. ${trackerFailureText(route.failure)}`,
          );
        }
      } else if (route._tag === "StartAgent") {
        await startTrackedAgent(route.input);
      } else {
        const created = await createThread({
          environmentId,
          input: { ...route.input, creationSource: "mobile" },
        });
        if (created._tag === "Success") openThread(String(route.input.threadId));
        else if (!isAtomCommandInterrupted(created))
          setError("Could not start a new thread. Try again.");
      }
    } catch {
      setError("Could not start a new thread. Try again.");
    }
    busyRef.current = false;
    setBusy(false);
  };
  if (!offered)
    return error || starting ? (
      <View className="mx-3 mb-2 gap-2">
        {starting && (
          <Notice message={starting} tone="default" onDismiss={() => setStarting(null)} />
        )}
        {error && <Notice message={error} tone="danger" onDismiss={() => setError(null)} />}
      </View>
    ) : null;
  return (
    <View className="mx-3 mb-2 gap-2">
      <Notice
        message="This conversation is long and has been idle. A new one starts without its history."
        tone="default"
      />
      <View className="flex-row flex-wrap gap-2">
        <Button
          label="Start fresh"
          tone="primary"
          disabled={busy}
          onPress={() => void startFresh()}
        />
        <Button
          label="Keep full history"
          tone="text"
          disabled={busy}
          onPress={() => setDismissed(key)}
        />
      </View>
      {starting && <Notice message={starting} tone="default" onDismiss={() => setStarting(null)} />}
      {error && <Notice message={error} tone="danger" onDismiss={() => setError(null)} />}
    </View>
  );
}
