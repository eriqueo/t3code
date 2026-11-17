import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, TrackerPortfolio, TrackerWorkDetail } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/reactivity";

import { primaryServerConfigAtom, serverEnvironment } from "./server";

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

const NO_LINKED_WORK = Atom.make<string | null>(null);

/**
 * The title of the work a conversation is linked to, from the shared portfolio poll.
 * A string result, so a sidebar row re-renders only when its own link changes.
 */
const linkedWorkTitleAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = key.split("\n") as [EnvironmentId, string];
  return Atom.make((get): string | null => {
    const portfolio = AsyncResult.getOrElse(
      get(serverEnvironment.trackerPortfolio({ environmentId, input: {} })),
      () => null,
    );
    const workId = portfolio?.links.find((link) => link.threadId === threadId)?.workId;
    if (workId === undefined) return null;
    return portfolio?.works.find((work) => work.id === workId)?.title ?? workId;
  });
});

/** Links are reported per host, so only the tracker environment's own threads can show one. */
export function useTrackerLinkedWorkTitle(
  environmentId: EnvironmentId,
  threadId: string,
): string | null {
  const trackerEnvironmentId = useTrackerEnvironmentId();
  return useAtomValue(
    trackerEnvironmentId === environmentId
      ? linkedWorkTitleAtom(`${environmentId}\n${threadId}`)
      : NO_LINKED_WORK,
  );
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
