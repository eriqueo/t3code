import type {
  ModelSelection,
  ThreadId,
  TrackerStartAgentInput,
  TrackerThreadOwner,
  TrackerThreadOwnerInput,
} from "@t3tools/contracts";

import { squashAtomCommandFailure, type AtomCommandResult } from "./state/runtime.ts";

export type StartFreshRoute =
  | { readonly _tag: "Handoff" }
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
 * Eric's decisions follow it. One that owns none keeps the context handoff. When the hub cannot
 * say, nothing starts: a guess either way would strand his decisions.
 */
export async function routeStartFresh(input: {
  /** The environment's server reaches a tracker hub. */
  readonly trackerHub: boolean;
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection;
  /** Fresh per press; the hub starts one agent per key. */
  readonly key: string;
  readonly ownerOf: (
    input: TrackerThreadOwnerInput,
  ) => Promise<AtomCommandResult<TrackerThreadOwner, unknown>>;
}): Promise<StartFreshRoute> {
  if (!input.trackerHub) return { _tag: "Handoff" };
  const owner = await input.ownerOf({ threadId: input.threadId });
  if (owner._tag === "Failure") return { _tag: "OwnerUnknown", failure: owner };
  if (owner.value.workId === null) return { _tag: "Handoff" };
  return {
    _tag: "StartAgent",
    input: { workId: owner.value.workId, key: input.key, model: input.modelSelection },
  };
}

/** The hub's own words for a failed tracker call. */
export function trackerFailureText(result: Parameters<typeof squashAtomCommandFailure>[0]) {
  const error = squashAtomCommandFailure(result);
  if (typeof error === "object" && error !== null && "detail" in error) {
    return String(error.detail);
  }
  return error instanceof Error ? error.message : "The tracker hub did not answer.";
}

export const agentStillStartingText = (host: string) =>
  `The agent is still starting on ${host}. It will appear in your threads, and as the record's conversation on the Tracker page.`;
