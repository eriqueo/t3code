import type {
  OrchestrationV2AppThread,
  ThreadId,
  TrackerStartAgentInput,
  TrackerThreadOwner,
  TrackerThreadOwnerInput,
} from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import type { CreateThreadInput } from "./operations/commands.ts";
import { squashAtomCommandFailure, type AtomCommandResult } from "./state/runtime.ts";

export type StartFreshRoute =
  | { readonly _tag: "NewThread"; readonly input: CreateThreadInput }
  | { readonly _tag: "StartAgent"; readonly input: TrackerStartAgentInput }
  | {
      readonly _tag: "OwnerUnknown";
      readonly failure: Extract<
        AtomCommandResult<TrackerThreadOwner, unknown>,
        { _tag: "Failure" }
      >;
    };

/**
 * Start fresh on a conversation that owns a tracker record asks the hub for the new agent, so
 * Eric's decisions follow it. One that owns none opens an empty conversation on the same model
 * and workspace; nothing from the old one is carried. When the hub cannot say, nothing starts:
 * a guess either way would strand his decisions.
 */
export async function routeStartFresh(input: {
  /** The environment's server reaches a tracker hub. */
  readonly trackerHub: boolean;
  readonly thread: Pick<
    OrchestrationV2AppThread,
    | "id"
    | "projectId"
    | "modelSelection"
    | "runtimeMode"
    | "interactionMode"
    | "branch"
    | "worktreePath"
  >;
  readonly newThreadId: ThreadId;
  /** Fresh per press; the hub starts one agent per key. */
  readonly key: string;
  readonly ownerOf: (
    input: TrackerThreadOwnerInput,
  ) => Promise<AtomCommandResult<TrackerThreadOwner, unknown>>;
  readonly resolve?: MFunctionType;
}): Promise<StartFreshRoute> {
  const { thread } = input;
  const newThread = {
    _tag: "NewThread",
    input: {
      threadId: input.newThreadId,
      projectId: thread.projectId,
      title: (input.resolve ?? mFallback)(msg("New thread")),
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      branch: thread.branch,
      worktreePath: thread.worktreePath,
    },
  } as const;
  if (!input.trackerHub) return newThread;
  const owner = await input.ownerOf({ threadId: thread.id });
  if (owner._tag === "Failure") return { _tag: "OwnerUnknown", failure: owner };
  if (owner.value.workId === null) return newThread;
  return {
    _tag: "StartAgent",
    input: { workId: owner.value.workId, key: input.key, model: thread.modelSelection },
  };
}

/** The hub's own words for a failed tracker call. */
export function trackerFailureText(
  result: Parameters<typeof squashAtomCommandFailure>[0],
  resolve: MFunctionType = mFallback,
) {
  const error = squashAtomCommandFailure(result);
  if (typeof error === "object" && error !== null && "detail" in error) {
    return String(error.detail);
  }
  return error instanceof Error ? error.message : resolve(msg("The tracker hub did not answer."));
}

export const agentStillStartingText = (host: string, resolve: MFunctionType = mFallback) =>
  resolve(
    msg(
      "The agent is still starting on {host}. It will appear in your threads, and as the record's conversation on the Tracker page.",
      { host },
    ),
  );
