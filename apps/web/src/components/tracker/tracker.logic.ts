import type {
  TrackerPhase,
  TrackerPortfolio,
  TrackerProgress,
  TrackerWorkDetail,
  TrackerWorkSummary,
} from "@t3tools/contracts";

/** Herdr terminals share the hub's link slot; T3 cannot open one. */
const HERDR_LINK_PREFIX = "herdr:";

export function linkedWorkIdForThread(
  portfolio: Pick<TrackerPortfolio, "links"> | null,
  threadId: string,
): string | null {
  return portfolio?.links.find((link) => link.threadId === threadId)?.workId ?? null;
}

/** The T3 thread to reopen, or null when the link lives on another host or in Herdr. */
export function resumableThreadId(work: Pick<TrackerWorkDetail, "thread" | "host">): string | null {
  const thread = work.thread;
  if (thread === null || thread.host !== work.host) return null;
  return thread.threadId.startsWith(HERDR_LINK_PREFIX) ? null : thread.threadId;
}

export interface TrackerDomainSection {
  readonly id: string;
  readonly label: string;
  readonly colour: string | null;
  readonly needYou: number;
  readonly works: ReadonlyArray<TrackerWorkSummary>;
}

const UNFILED_DOMAIN = "unfiled";

/**
 * Domains in hub order, each with its work that can still move. Work the hub
 * files under no group still shows, so nothing live is hidden by a missing domain.
 */
export function domainSections(
  portfolio: TrackerPortfolio,
  domainFilter: string | null,
): ReadonlyArray<TrackerDomainSection> {
  const byId = new Map(portfolio.works.map((work) => [work.id, work]));
  const placed = new Set<string>();
  const sections: Array<TrackerDomainSection> = portfolio.domains.map((domain) => {
    const works = domain.workIds.flatMap((id) => {
      const work = byId.get(id);
      if (work === undefined) return [];
      placed.add(id);
      return [work];
    });
    return {
      id: domain.id,
      label: domain.label,
      colour: domain.colour,
      needYou: works.filter((work) => work.waitingOnYou).length,
      works,
    };
  });
  const unfiled = portfolio.works.filter((work) => !placed.has(work.id));
  if (unfiled.length > 0) {
    sections.push({
      id: UNFILED_DOMAIN,
      label: "Parked and unfiled",
      colour: null,
      needYou: unfiled.filter((work) => work.waitingOnYou).length,
      works: unfiled,
    });
  }
  return sections.filter(
    (section) => section.works.length > 0 && (domainFilter === null || section.id === domainFilter),
  );
}

export type TrackerTone = "attention" | "problem" | "quiet" | "ok";

/** One status word per work item: the thing Eric acts on first wins. */
export function workStatus(
  work: Pick<TrackerWorkSummary, "waitingOnYou" | "overdue" | "status" | "state">,
): { readonly label: string; readonly tone: TrackerTone } {
  if (work.waitingOnYou) return { label: "Waiting on you", tone: "attention" };
  if (work.overdue) return { label: "Overdue", tone: "problem" };
  if (work.status === "parked") return { label: "Parked", tone: "quiet" };
  if (work.state === "stale") return { label: "Stale", tone: "quiet" };
  return { label: "On track", tone: "ok" };
}

/** A fraction only where phases exist; a task without phases has no percentage to show. */
export function progressFraction(progress: TrackerProgress): number | null {
  if (progress.total <= 0) return null;
  return Math.min(1, Math.max(0, progress.done / progress.total));
}

export function currentPhase(phases: ReadonlyArray<TrackerPhase>): TrackerPhase | null {
  return phases.find((phase) => phase.status !== "done") ?? null;
}

export function phaseStatusLabel(phase: Pick<TrackerPhase, "status" | "wait">): string {
  switch (phase.status) {
    case "done":
      return "Done";
    case "waiting":
      return phase.wait ? `Waiting: ${phase.wait}` : "Waiting";
    case "next":
      return "Next";
    case "active":
      return "In progress";
    default:
      return phase.status === "" ? "Planned" : phase.status;
  }
}
