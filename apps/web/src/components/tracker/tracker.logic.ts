import type {
  TrackerCard,
  TrackerCardSeen,
  TrackerPhase,
  TrackerPortfolio,
  TrackerProgress,
  TrackerWatch,
  TrackerWorkDetail,
  TrackerWorkSummary,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

/** Hyphens, underscores and spaces all separate words, so "work memory" finds `work-memory-ownership`. */
const searchWords = (text: string) =>
  text
    .toLowerCase()
    .replace(/[-_\s]+/g, " ")
    .trim();

/** Eric searches by the title he sees or by the id an agent reported. */
export function workMatchesQuery(work: Pick<TrackerWorkSummary, "title" | "id">, query: string) {
  const needle = searchWords(query);
  return needle === "" || searchWords(`${work.title} ${work.id}`).includes(needle);
}

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
  resolve: MessageResolver = m,
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
      label: resolve(msg("Parked and unfiled")),
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
  resolve: MessageResolver = m,
): { readonly label: string; readonly tone: TrackerTone } {
  if (work.waitingOnYou) return { label: resolve(msg("Waiting on you")), tone: "attention" };
  if (work.overdue) return { label: resolve(msg("Overdue")), tone: "problem" };
  if (work.status === "parked") {
    return { label: resolve(msg("Parked", { $context: "tracker work status" })), tone: "quiet" };
  }
  if (work.state === "stale") return { label: resolve(msg("Stale")), tone: "quiet" };
  return { label: resolve(msg("On track")), tone: "ok" };
}

/** A fraction only where phases exist; a task without phases has no percentage to show. */
export function progressFraction(progress: TrackerProgress): number | null {
  if (progress.total <= 0) return null;
  return Math.min(1, Math.max(0, progress.done / progress.total));
}

/** The hub's own document view, which renders Markdown and serves HTML, PDFs and images. */
export function trackerDocUrl(hubUrl: string, workId: string, path: string): string {
  return `${hubUrl}/p/${encodeURIComponent(workId)}/docs?doc=${encodeURIComponent(path)}`;
}

/** The sidebar's one line: a tagline when the record has one, else the goal. */
export function trackerSummary(work: Pick<TrackerWorkDetail, "tagline" | "goal">): string {
  return work.tagline.trim() || work.goal.trim();
}

/** The phase being worked on: one marked active, else the first not yet done or dropped. */
export function currentPhase(phases: ReadonlyArray<TrackerPhase>): TrackerPhase | null {
  return (
    phases.find((phase) => phase.status === "active") ??
    phases.find((phase) => phase.status !== "done" && phase.status !== "dropped") ??
    null
  );
}

/**
 * Why this conversation may not act on the record, or null when it owns it. The record's
 * own `thread` is the hub's owner; one released by settling has none.
 */
export function trackerActionRefusal(
  work: Pick<TrackerWorkDetail, "thread">,
  threadId: string,
  resolve: MessageResolver = m,
): string | null {
  const owner = work.thread;
  if (owner === null) return resolve(msg("This record has no conversation. Link this one first."));
  if (owner.threadId === threadId) return null;
  return resolve(
    msg("This record belongs to {owner}. Open that conversation or move the link here.", {
      owner: owner.title || owner.threadId,
    }),
  );
}

/** One line for a watch: what it waits for is its title, this is where it stands. */
export function watchStateLabel(
  watch: Pick<TrackerWatch, "snoozedUntil" | "delivery">,
  formatTime: (iso: string) => string,
  resolve: MessageResolver = m,
): string {
  if (watch.delivery === "pending") return resolve(msg("Fired · waking the agent"));
  if (watch.delivery === "failed") return resolve(msg("Fired · the wake failed, retrying"));
  if (watch.snoozedUntil !== null) {
    return resolve(msg("Snoozed until {time}", { time: formatTime(watch.snoozedUntil) }));
  }
  return resolve(msg("Watching · checked every 15 minutes"));
}

export function phaseStatusLabel(
  phase: Pick<TrackerPhase, "status" | "wait">,
  resolve: MessageResolver = m,
): string {
  switch (phase.status) {
    case "done":
      return resolve(msg("Done", { $context: "roadmap phase status" }));
    case "dropped":
      return resolve(msg("Dropped", { $context: "roadmap phase status" }));
    case "waiting":
      return phase.wait
        ? resolve(msg("Waiting: {wait}", { wait: phase.wait }))
        : resolve(msg("Waiting", { $context: "roadmap phase status" }));
    case "next":
      return resolve(msg("Next", { $context: "roadmap phase status" }));
    case "active":
      return resolve(msg("In progress"));
    default:
      // A status this build does not know stays in the hub's words.
      return phase.status === ""
        ? resolve(msg("Planned", { $context: "roadmap phase status" }))
        : phase.status;
  }
}

/** What Eric read on a card; the server refuses an answer once the card moves on. */
export function trackerCardSeen(card: TrackerCard): TrackerCardSeen {
  return {
    id: card.id,
    status: card.status,
    title: card.title,
    ask: card.ask,
    comments: card.comments.length,
  };
}

const DECIDED = new Set(["approved", "rejected", "answered"]);

/** Cards still waiting on Eric, and those he answered that the agent has not finished. */
export function decisionCards(cards: ReadonlyArray<TrackerCard>): {
  readonly open: ReadonlyArray<TrackerCard>;
  readonly decided: ReadonlyArray<TrackerCard>;
} {
  return {
    open: cards.filter((card) => card.status === "open"),
    decided: cards.filter((card) => DECIDED.has(card.status)),
  };
}

export function cardStatusLabel(
  card: Pick<TrackerCard, "status">,
  resolve: MessageResolver = m,
): string {
  switch (card.status) {
    case "open":
      return resolve(msg("Waiting on you"));
    case "approved":
      return resolve(msg("Approved", { $context: "decision card status" }));
    case "rejected":
      return resolve(msg("Rejected", { $context: "decision card status" }));
    case "answered":
      return resolve(msg("Answered", { $context: "decision card status" }));
    default:
      return card.status;
  }
}

/** The hub's minute stamps, read as a date and a time. */
export function trackerWhen(at: string): string {
  return at.replace("T", " ").slice(0, 16);
}

/** The Done deciding line, in the hub page's words. Each case is one whole sentence. */
export function doneDecidingText(
  work: Pick<TrackerWorkDetail, "handoff" | "thread">,
  resolve: MessageResolver = m,
): string {
  const { handoff, thread } = work;
  const title = thread?.title || null;
  const host = thread?.host ?? null;
  const at = handoff.at === null ? null : trackerWhen(handoff.at);
  if (!handoff.waiting) {
    if (thread === null) {
      return resolve(
        msg("Send your saved answers. No conversation is linked, so the hub starts one."),
      );
    }
    return title === null
      ? resolve(msg("Send your saved answers to the linked conversation on {host}.", { host }))
      : resolve(msg("Send your saved answers to {title} on {host}.", { title, host }));
  }
  switch (handoff.delivery) {
    case "pending":
      if (at === null) {
        return host === null
          ? resolve(msg("Recorded; waiting for the relay to post it."))
          : resolve(msg("Recorded; waiting for {host} to post it.", { host }));
      }
      return host === null
        ? resolve(msg("Recorded {at}; waiting for the relay to post it.", { at }))
        : resolve(msg("Recorded {at}; waiting for {host} to post it.", { at, host }));
    case "stale": {
      const reason = handoff.reason;
      if (at === null) {
        return reason === null
          ? resolve(msg("Recorded, not posted yet: no reason given."))
          : resolve(msg("Recorded, not posted yet: {reason}.", { reason }));
      }
      return reason === null
        ? resolve(msg("Recorded {at}, not posted yet: no reason given.", { at }))
        : resolve(msg("Recorded {at}, not posted yet: {reason}.", { at, reason }));
    }
    case "sent":
      if (thread === null) {
        return at === null ? resolve(msg("Sent.")) : resolve(msg("Sent {at}.", { at }));
      }
      if (title === null) {
        return at === null
          ? resolve(msg("Sent to the linked conversation on {host}.", { host }))
          : resolve(msg("Sent {at} to the linked conversation on {host}.", { at, host }));
      }
      return at === null
        ? resolve(msg("Sent to {title} on {host}.", { title, host }))
        : resolve(msg("Sent {at} to {title} on {host}.", { at, title, host }));
    default: {
      const reason = handoff.reason;
      if (at === null) {
        return reason === null
          ? resolve(msg("Saved, but not sent: no delivery yet."))
          : resolve(msg("Saved, but not sent: {reason}.", { reason }));
      }
      return reason === null
        ? resolve(msg("Saved {at}, but not sent: no delivery yet.", { at }))
        : resolve(msg("Saved {at}, but not sent: {reason}.", { at, reason }));
    }
  }
}
