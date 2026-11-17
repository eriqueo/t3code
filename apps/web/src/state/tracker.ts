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
