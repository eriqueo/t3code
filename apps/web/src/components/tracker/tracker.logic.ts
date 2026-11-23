import type {
  TrackerCard,
  TrackerCardSeen,
  TrackerPhase,
  TrackerPortfolio,
  TrackerProgress,
  TrackerWorkDetail,
  TrackerWorkSummary,
} from "@t3tools/contracts";

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
 * Sidebar buttons. Each sends the agent in the linked conversation one message; the
 * procedure for each id lives in the project-tracker skill's "Sidebar actions" section.
 */
export type TrackerActionId =
  | "next-step"
  | "update-roadmap"
  | "handoff"
  | "grill"
  | "prove-it"
  | "close-out";

export interface TrackerAction {
  readonly id: TrackerActionId;
  readonly label: string;
  /** Asks before sending: the action cannot be undone. */
  readonly confirm: boolean;
}

const PROJECT_ACTIONS: ReadonlyArray<TrackerAction> = [
  { id: "next-step", label: "Next Step", confirm: false },
  { id: "update-roadmap", label: "Update Roadmap", confirm: false },
  { id: "handoff", label: "Handoff", confirm: false },
  { id: "grill", label: "Grill the Plan", confirm: false },
  { id: "prove-it", label: "Prove It", confirm: false },
  { id: "close-out", label: "Close Out", confirm: true },
];

const PROJECT_ONLY = new Set<TrackerActionId>(["update-roadmap", "handoff"]);

/**
 * A record without phases has no roadmap and needs no handoff, so it gets neither
 * button. Phases decide, not the record's kind (tracker K4).
 */
export function trackerActions(
  work: Pick<TrackerWorkDetail, "phases">,
): ReadonlyArray<TrackerAction> {
  return work.phases.length > 0
    ? PROJECT_ACTIONS
    : PROJECT_ACTIONS.filter((action) => !PROJECT_ONLY.has(action.id));
}

/**
 * Why this conversation may not act on the record, or null when it owns it. The record's
 * own `thread` is the hub's owner; one released by settling has none.
 */
export function trackerActionRefusal(
  work: Pick<TrackerWorkDetail, "thread">,
  threadId: string,
): string | null {
  const owner = work.thread;
  if (owner === null) return "This record has no conversation. Link this one first.";
  if (owner.threadId === threadId) return null;
  return `This record belongs to ${owner.title || owner.threadId}. Open that conversation or move the link here.`;
}

/** Names the record and this thread so the skill can refuse when the link has moved. */
export function trackerActionMessage(
  id: TrackerActionId,
  workId: string,
  threadId: string,
): string {
  // The review attacks the agent's own last result, so it needs no tracker procedure.
  // The message says what counts as that result: the button can be pressed after a
  // status note, and the agent must not review the note or this request.
  if (id === "prove-it") {
    return `Use prove-it on your latest substantive result in this conversation: the last plan, diagnosis, findings, report or code change you gave, not a status note or your reply to this message. Name that target in one sentence, then start the review. If a newer message from Eric changed the subject, say which result you would review and ask first (record \`${workId}\`, thread \`${threadId}\`).`;
  }
  const action = `Use project-tracker: sidebar action \`${id}\` on record \`${workId}\` from thread \`${threadId}\`.`;
  // A tidy keeps the project open, so it rides with the roadmap update rather than Close Out.
  return id === "update-roadmap"
    ? `${action} Then use project-tidy: remove finished scratch, stale files and merged branches, and bring the plan, handoff and tracker record up to date.`
    : action;
}

export function phaseStatusLabel(phase: Pick<TrackerPhase, "status" | "wait">): string {
  switch (phase.status) {
    case "done":
      return "Done";
    case "dropped":
      return "Dropped";
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

export function cardStatusLabel(card: Pick<TrackerCard, "status">): string {
  switch (card.status) {
    case "open":
      return "Waiting on you";
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    case "answered":
      return "Answered";
    default:
      return card.status;
  }
}

/** The hub's minute stamps, read as a date and a time. */
export function trackerWhen(at: string): string {
  return at.replace("T", " ").slice(0, 16);
}

/** The Done deciding line, in the hub page's words. */
export function doneDecidingText(work: Pick<TrackerWorkDetail, "handoff" | "thread">): string {
  const { handoff, thread } = work;
  const target =
    thread === null ? null : `${thread.title || "the linked conversation"} on ${thread.host}`;
  const at = handoff.at === null ? "" : ` ${trackerWhen(handoff.at)}`;
  if (!handoff.waiting) {
    return target === null
      ? "Send your saved answers. No conversation is linked, so the hub starts one."
      : `Send your saved answers to ${target}.`;
  }
  switch (handoff.delivery) {
    case "pending":
      return `Recorded${at}; waiting for ${thread?.host ?? "the relay"} to post it.`;
    case "stale":
      return `Recorded${at}, not posted yet: ${handoff.reason ?? "no reason given"}.`;
    case "sent":
      return `Sent${at}${target === null ? "" : ` to ${target}`}.`;
    default:
      return `Saved${at}, but not sent: ${handoff.reason ?? "no delivery yet"}.`;
  }
}
