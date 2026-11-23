import { useAtomValue } from "@effect/atom-react";
import {
  ThreadId,
  type EnvironmentId,
  type TrackerPortfolio,
  type TrackerThreadRecord,
  type TrackerWorkDetail,
} from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
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

/** What the sidebar groups and labels a conversation by. */
type ThreadRecord = Pick<TrackerThreadRecord, "domain" | "domainLabel" | "subdomain">;

const sameRecords = (
  left: ReadonlyMap<string, ThreadRecord>,
  right: ReadonlyMap<string, ThreadRecord>,
) =>
  left.size === right.size &&
  [...right].every(([key, record]) => {
    const other = left.get(key);
    return (
      other !== undefined &&
      other.domain === record.domain &&
      other.domainLabel === record.domainLabel &&
      other.subdomain === record.subdomain
    );
  });

/**
 * Each listed machine's conversations with the record they own, keyed by scoped thread key.
 * `null` until a machine's server has read its hub, so the sidebar keeps its folders while the
 * hub is out. Keeps its previous map while the 5-second poll returns the same links, so the
 * sidebar does not re-render on every poll.
 */
const threadRecordsAtom = Atom.family((key: string) =>
  Atom.make((get): ReadonlyMap<string, ThreadRecord> | null => {
    const previous = Option.getOrNull(get.self<ReadonlyMap<string, ThreadRecord> | null>());
    const next = new Map<string, ThreadRecord>();
    let answered = false;
    for (const environmentId of key.split("\n") as EnvironmentId[]) {
      if (
        environmentId === "" ||
        get(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities
          .trackerHub !== true
      ) {
        continue;
      }
      const portfolio = AsyncResult.getOrElse(
        get(serverEnvironment.trackerPortfolio({ environmentId, input: {} })),
        () => null,
      );
      if (portfolio === null) continue;
      answered = true;
      for (const entry of portfolio.threads) {
        next.set(scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(entry.threadId))), {
          domain: entry.domain,
          domainLabel: entry.domainLabel,
          subdomain: entry.subdomain,
        });
      }
    }
    if (!answered) return null;
    return previous !== null && sameRecords(previous, next) ? previous : next;
  }),
);

export function useTrackerThreadRecords(
  environmentIds: readonly EnvironmentId[],
): ReadonlyMap<string, ThreadRecord> | null {
  return useAtomValue(threadRecordsAtom(environmentIds.toSorted().join("\n")));
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
