import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import {
  CommandId,
  ThreadId,
  REVIEW_PROVIDER_INSTANCE_ID,
  type EnvironmentId,
  type OrchestrationV2ThreadProjection,
  type TrackerStartAgentInput,
} from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { ThreadHandoffCommand } from "@t3tools/client-runtime/state/threads";
import {
  agentStillStartingText,
  routeStartFresh,
  trackerFailureText,
} from "@t3tools/client-runtime/tracker-start";
import {
  latestContextCheckpoint,
  shouldPrepareThreadHandoff,
} from "@t3tools/shared/contextHandoff";
import * as DateTime from "effect/DateTime";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Notice } from "../../components/ui/Notice";
import { Button } from "../../components/ui/Button";
import { uuidv4 } from "../../lib/uuid";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

export function CompactHandoffCard(props: {
  readonly environmentId: EnvironmentId;
  readonly projection: OrchestrationV2ThreadProjection | null;
  readonly supported: boolean;
  readonly snapshotCurrent: boolean;
}) {
  const { projection, environmentId } = props;
  const navigation = useNavigation();
  const canOperate = useAtomValue(threadEnvironment.handoff.permissionAtom(environmentId));
  const dispatch = useAtomCommand(threadEnvironment.handoff, { reportFailure: false });
  const ownerOf = useAtomCommand(serverEnvironment.trackerThreadOwner, { reportFailure: false });
  const startAgent = useAtomCommand(serverEnvironment.trackerStartAgent, { reportFailure: false });
  const trackerHub =
    useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities
      .trackerHub === true;
  const requested = useRef<string | null>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const source = projection?.messages.findLast(
    (message) => message.role === "user" && !message.streaming,
  );
  const current = projection?.thread.compactHandoff;
  const state = current && source && current.sourceMessageId === source.id ? current : null;
  const available =
    props.supported &&
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Synchronizes the server's durable handoff preparation with idle thread eligibility while mounted.
  useEffect(() => {
    if (!available || !projection || !source) return;
    const key = JSON.stringify([environmentId, projection.thread.id, source.id]);
    const usage = projection.providerTurns
      .flatMap((turn) => (turn.tokenUsage ? [turn.tokenUsage] : []))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
    const activeProvider = projection.providerThreads.find(
      (thread) => thread.id === projection.thread.activeProviderThreadId,
    );
    if (
      requested.current === key ||
      !shouldPrepareThreadHandoff({
        snapshotCurrent: props.snapshotCurrent,
        hasExplicitCheckpoint: latestContextCheckpoint(projection.messages).state !== "none",
        nowMs: Date.now(),
        latestMessageAt: DateTime.formatIso(source.updatedAt),
        usedTokens: usage?.usedTokens ?? activeProvider?.contextUsage?.usedTokens ?? null,
        sessionStatus: working ? "running" : "idle",
        latestTurnState: working ? "running" : "completed",
        hasPendingRequest: blocked,
        handoffState: state?.state ?? "none",
      })
    )
      return;
    requested.current = key;
    void dispatch({
      environmentId,
      input: {
        type: "thread.handoff.prepare",
        commandId: CommandId.make(uuidv4()),
        threadId: projection.thread.id,
        sourceMessageId: source.id,
      },
    }).then((result) => {
      if (result._tag === "Failure") {
        requested.current = null;
        setError("Could not request a handoff. Try again.");
      }
    });
  }, [
    available,
    projection,
    source,
    environmentId,
    props.snapshotCurrent,
    working,
    blocked,
    state?.state,
    dispatch,
  ]);
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
  const act = async (command: ThreadHandoffCommand) => {
    if (busyRef.current || !canOperate) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const route =
        command.type === "thread.handoff.start" && projection
          ? await routeStartFresh({
              trackerHub,
              threadId: projection.thread.id,
              modelSelection: projection.thread.modelSelection,
              key: uuidv4(),
              ownerOf: (ownerInput) => ownerOf({ environmentId, input: ownerInput }),
            })
          : ({ _tag: "Handoff" } as const);
      if (route._tag === "OwnerUnknown") {
        if (!isAtomCommandInterrupted(route.failure)) {
          setError(
            `Could not check whether a tracker record follows this conversation. ${trackerFailureText(route.failure)}`,
          );
        }
      } else if (route._tag === "StartAgent") {
        await startTrackedAgent(route.input);
      } else {
        await handoff(command);
      }
    } catch {
      setError("Could not open the handoff. Try again.");
    }
    busyRef.current = false;
    setBusy(false);
  };
  const handoff = async (command: ThreadHandoffCommand) => {
    const result = await dispatch({ environmentId, input: command });
    if (result._tag === "Failure") {
      setError("Could not update the handoff. Try again.");
    } else if (command.type === "thread.handoff.start") {
      openThread(String(command.targetThreadId));
    }
  };
  if (available && error && !state)
    return (
      <View className="mx-3 mb-2">
        <Notice message={error} tone="danger" onDismiss={() => setError(null)} />
      </View>
    );
  if (
    !available ||
    !projection ||
    !source ||
    !state ||
    state.state === "dismissed" ||
    state.state === "started"
  )
    return null;
  const disabled = busy || working || blocked || !props.snapshotCurrent;
  const threadId = projection.thread.id;
  return (
    <View className="mx-3 mb-2 gap-2">
      <Notice
        message={
          state.state === "requested"
            ? "Preparing a compact handoff. You can keep working here."
            : state.state === "failed"
              ? state.detail
              : "A fresh-conversation handoff is ready."
        }
        tone={state.state === "failed" ? "danger" : "default"}
      />
      <View className="flex-row flex-wrap gap-2">
        {state.state !== "requested" && (
          <Button
            label={state.state === "ready" ? "Regenerate" : "Retry"}
            disabled={disabled}
            onPress={() =>
              void act({
                type: "thread.handoff.prepare",
                commandId: CommandId.make(uuidv4()),
                threadId,
                sourceMessageId: source.id,
                retry: true,
              })
            }
          />
        )}
        {state.state === "ready" && (
          <Button
            label="Start fresh"
            tone="primary"
            disabled={disabled}
            onPress={() =>
              void act({
                type: "thread.handoff.start",
                commandId: CommandId.make(uuidv4()),
                threadId,
                requestId: state.requestId,
                targetThreadId: ThreadId.make(uuidv4()),
                createdBy: "user",
                creationSource: "mobile",
              })
            }
          />
        )}
        <Button
          label="Keep full history"
          tone="text"
          disabled={busy}
          onPress={() =>
            void act({
              type: "thread.handoff.dismiss",
              commandId: CommandId.make(uuidv4()),
              threadId,
              sourceMessageId: source.id,
            })
          }
        />
      </View>
      {starting && <Notice message={starting} tone="default" onDismiss={() => setStarting(null)} />}
      {error && <Notice message={error} tone="danger" onDismiss={() => setError(null)} />}
    </View>
  );
}
