import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { agentStillStartingText, trackerFailureText } from "@t3tools/client-runtime/tracker-start";
import {
  ThreadId,
  type EnvironmentId,
  type ModelSelection,
  type TrackerStartAgentInput,
} from "@t3tools/contracts";
import { pickModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { useGT, useMessages } from "gt-react";
import { useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { getCustomModelOptionsByInstance } from "~/modelSelection";
import { providerInstanceEntriesFor } from "~/providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";

import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { scheduledTaskDefaultModel } from "../settings/scheduledTasksSettings.logic";
import { toastManager } from "../ui/toast";

/**
 * Asks the hub to start an agent for a record, then opens its conversation once the relay
 * names it. Resolves true when the hub took the start.
 */
export function useTrackerAgentStart() {
  const start = useAtomCommand(serverEnvironment.trackerStartAgent, { reportFailure: false });
  const navigate = useNavigate();
  const gt = useGT();
  const resolve = useMessages();
  return async (environmentId: EnvironmentId, input: TrackerStartAgentInput) => {
    const result = await start({ environmentId, input });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: gt("Could not start the agent"),
          description: trackerFailureText(result, resolve),
        });
      }
      return false;
    }
    if (result.value.threadId === null) {
      toastManager.add({
        type: "info",
        title: gt("Agent starting"),
        description: agentStillStartingText(result.value.host, resolve),
      });
      return true;
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(
        scopeThreadRef(environmentId, ThreadId.make(result.value.threadId)),
      ),
    });
    return true;
  };
}

/**
 * The model a new agent runs on: the composer's most recent pick while that provider is still
 * on, else the environment's default. Null when no provider can run one; the relay then picks.
 */
export function useTrackerModelChoice(environmentId: EnvironmentId) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const sticky = useComposerDraftStore((state) =>
    state.stickyActiveProvider === null
      ? null
      : (state.stickyModelSelectionByProvider[state.stickyActiveProvider] ?? null),
  );
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const entries = providerInstanceEntriesFor(providers, settings, null);
  const recent =
    sticky !== null &&
    entries.some((entry) => entry.instanceId === sticky.instanceId && entry.enabled)
      ? sticky
      : null;
  const selection = picked ?? recent ?? scheduledTaskDefaultModel(settings, null, entries);
  const picker =
    selection === null ? null : (
      <ProviderModelPicker
        environmentId={environmentId}
        activeInstanceId={selection.instanceId}
        model={selection.model}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={getCustomModelOptionsByInstance(
          settings,
          providers,
          selection.instanceId,
          selection.model,
        )}
        isComposerOwned={false}
        onInstanceModelChange={(instanceId, model) =>
          setPicked(pickModelSelection(selection, instanceId, model))
        }
      />
    );
  return { selection, picker };
}
