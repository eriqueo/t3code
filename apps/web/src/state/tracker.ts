import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, TrackerPortfolio, TrackerWorkDetail } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentServerConfigsAtom, primaryServerConfigAtom, serverEnvironment } from "./server";

export interface TrackerRead<A> {
  readonly value: A | null;
  /** Set when the last refresh failed; `value` may still hold the last good answer. */
  readonly error: string | null;
  readonly loading: boolean;
}

const EMPTY_READ = Atom.make(AsyncResult.initial<never, never>());

function toRead<A>(result: AsyncResult.AsyncResult<A, unknown>): TrackerRead<A> {
  const value = AsyncResult.getOrElse(result, () => null);
  return {
    value,
    error: AsyncResult.isFailure(result) ? errorText(squashAtomCommandFailure(result)) : null,
    loading: value === null && !AsyncResult.isFailure(result),
  };
}

export function errorText(error: unknown): string {
  if (typeof error === "object" && error !== null && "detail" in error) {
    return String(error.detail);
  }
  return error instanceof Error ? error.message : "The tracker hub did not answer.";
}

/** The primary environment, when its server can reach a tracker hub. */
export function useTrackerEnvironmentId(): EnvironmentId | null {
  const config = useAtomValue(primaryServerConfigAtom);
  return config?.environment.capabilities.trackerHub === true
    ? config.environment.environmentId
    : null;
}

export function useTrackerPortfolio(
  environmentId: EnvironmentId | null,
): TrackerRead<TrackerPortfolio> {
  return toRead(
    useAtomValue(
      environmentId === null
        ? EMPTY_READ
        : serverEnvironment.trackerPortfolio({ environmentId, input: {} }),
    ),
  );
}

/**
 * The title of the work a conversation is linked to, from the shared portfolio poll.
 * A string result, so a sidebar row re-renders only when its own link changes.
 */
const linkedWorkTitleAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = key.split("\n") as [EnvironmentId, string];
  return Atom.make((get): string | null => {
    // Each machine's server reports its own host's links, so a remote thread asks its own server.
    if (
      get(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities.trackerHub !==
      true
    ) {
      return null;
    }
    const portfolio = AsyncResult.getOrElse(
      get(serverEnvironment.trackerPortfolio({ environmentId, input: {} })),
      () => null,
    );
    const workId = portfolio?.links.find((link) => link.threadId === threadId)?.workId;
    if (workId === undefined) return null;
    return portfolio?.works.find((work) => work.id === workId)?.title ?? workId;
  });
});

/** The linked work's title for a thread on any machine whose server can reach the hub. */
export function useTrackerLinkedWorkTitle(
  environmentId: EnvironmentId,
  threadId: string,
): string | null {
  return useAtomValue(linkedWorkTitleAtom(`${environmentId}\n${threadId}`));
}

/** Every connected machine whose server can reach a tracker hub. */
// A joined key, so a config push that changes nothing tracker-related renders nothing.
const trackerEnvironmentIdsKeyAtom = Atom.make((get): string => {
  const ids: Array<EnvironmentId> = [];
  for (const [environmentId, config] of get(environmentServerConfigsAtom)) {
    if (config.environment.capabilities.trackerHub === true) ids.push(environmentId);
  }
  return ids.join("\n");
});

export function useTrackerEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  const key = useAtomValue(trackerEnvironmentIdsKeyAtom);
  return key === "" ? [] : (key.split("\n") as Array<EnvironmentId>);
}

export function useTrackerWork(
  environmentId: EnvironmentId | null,
  workId: string | null,
): TrackerRead<TrackerWorkDetail> {
  return toRead(
    useAtomValue(
      environmentId === null || workId === null
        ? EMPTY_READ
        : serverEnvironment.trackerWork({ environmentId, input: { workId } }),
    ),
  );
}
