import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import {
  CommandId,
  ThreadId,
  REVIEW_PROVIDER_INSTANCE_ID,
  type EnvironmentId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import type { ThreadHandoffCommand } from "@t3tools/client-runtime/state/threads";
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
  const requested = useRef<string | null>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const source = projection?.messages.findLast(
    (message) => message.role === "user" && !message.streaming,
  );
  const current = projection?.thread.compactHandoff;
  const state = current?.sourceMessageId === source?.id ? current : null;
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
  const act = async (command: ThreadHandoffCommand) => {
    if (busyRef.current || !canOperate) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await dispatch({ environmentId, input: command });
      if (result._tag === "Failure") {
        setError("Could not update the handoff. Try again.");
        return;
      }
      if (command.type === "thread.handoff.start")
        navigation.dispatch(
          StackActions.replace("Thread", {
            environmentId: String(environmentId),
            threadId: String(command.targetThreadId),
          }),
        );
    } finally {
      busyRef.current = false;
      setBusy(false);
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
      {error && <Notice message={error} tone="danger" onDismiss={() => setError(null)} />}
    </View>
  );
}
