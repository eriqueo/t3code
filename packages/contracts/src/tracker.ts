import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

/**
 * The tracker hub owns these records. T3 reads them through its own server so a
 * remote browser never needs a route to the hub, and never stores a copy.
 */
/** The hub's end states: a record in one of them is closed and takes no close again. */
export const TRACKER_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "complete",
  "archived",
  "superseded",
  "dropped",
  "retired",
]);

export const TrackerWorkId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
);
export type TrackerWorkId = typeof TrackerWorkId.Type;

export const TrackerProgress = Schema.Struct({
  done: Schema.Number,
  total: Schema.Number,
});
export type TrackerProgress = typeof TrackerProgress.Type;

export const TrackerDomain = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  colour: Schema.NullOr(Schema.String),
  count: Schema.Number,
  needYou: Schema.Number,
  workIds: Schema.Array(Schema.String),
});
export type TrackerDomain = typeof TrackerDomain.Type;

export const TrackerWorkSummary = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  goal: Schema.String,
  domain: Schema.NullOr(Schema.String),
  status: Schema.String,
  /** The hub's own verdict: `ok`, `overdue`, `stale`, `complete`, and so on. */
  state: Schema.String,
  openCards: Schema.Number,
  waitingOnYou: Schema.Boolean,
  overdue: Schema.Boolean,
  lastWork: Schema.NullOr(Schema.String),
  progress: TrackerProgress,
});
export type TrackerWorkSummary = typeof TrackerWorkSummary.Type;

export const TrackerAttentionItem = Schema.Struct({
  key: Schema.String,
  workId: Schema.String,
  workTitle: Schema.String,
  title: Schema.String,
  kind: Schema.String,
  due: Schema.NullOr(Schema.String),
  expired: Schema.Boolean,
});
export type TrackerAttentionItem = typeof TrackerAttentionItem.Type;

/** A hub link between one work item and a conversation on this server's host. */
export const TrackerThreadLink = Schema.Struct({
  workId: Schema.String,
  threadId: Schema.String,
});
export type TrackerThreadLink = typeof TrackerThreadLink.Type;

/** The record a conversation on this server's host owns, by the record's own `thread`. */
export const TrackerThreadRecord = Schema.Struct({
  threadId: Schema.String,
  workId: Schema.String,
  domain: Schema.String,
  /** The hub's name for the domain, or its id when the hub names none. */
  domainLabel: Schema.String,
  subdomain: Schema.NullOr(Schema.String),
});
export type TrackerThreadRecord = typeof TrackerThreadRecord.Type;

export const TrackerPortfolio = Schema.Struct({
  /** The host name this server reports to the hub; links are scoped to it. */
  host: Schema.String,
  hubUrl: Schema.String,
  fetchedAt: Schema.String,
  today: Schema.String,
  liveCap: Schema.NullOr(Schema.Number),
  liveProjects: Schema.Number,
  domains: Schema.Array(TrackerDomain),
  works: Schema.Array(TrackerWorkSummary),
  attention: Schema.Array(TrackerAttentionItem),
  links: Schema.Array(TrackerThreadLink),
  /** One entry per conversation on this host that owns a record, finished records included. */
  threads: Schema.Array(TrackerThreadRecord),
});
export type TrackerPortfolio = typeof TrackerPortfolio.Type;

export const TrackerPhase = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: Schema.String,
  planned: Schema.NullOr(Schema.String),
  done: Schema.NullOr(Schema.String),
  terminal: Schema.Boolean,
  wait: Schema.NullOr(Schema.String),
});
export type TrackerPhase = typeof TrackerPhase.Type;

export const TrackerCardComment = Schema.Struct({
  at: Schema.NullOr(Schema.String),
  text: Schema.String,
});
export type TrackerCardComment = typeof TrackerCardComment.Type;

export const TrackerCard = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  title: Schema.String,
  ask: Schema.String,
  status: Schema.String,
  phase: Schema.String,
  context: Schema.String,
  plan: Schema.String,
  risk: Schema.String,
  recommend: Schema.String,
  decidedAt: Schema.NullOr(Schema.String),
  comments: Schema.Array(TrackerCardComment),
  /** False for bulk and review cards: their forms live on the hub's own page. */
  answerable: Schema.Boolean,
});
export type TrackerCard = typeof TrackerCard.Type;

export const TrackerBrief = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  title: Schema.String,
  summary: Schema.String,
  date: Schema.NullOr(Schema.String),
  wrong: Schema.Array(Schema.String),
});
export type TrackerBrief = typeof TrackerBrief.Type;

export const TrackerLinkedThread = Schema.Struct({
  host: Schema.String,
  threadId: Schema.String,
  title: Schema.String,
  linkedAt: Schema.NullOr(Schema.String),
});
export type TrackerLinkedThread = typeof TrackerLinkedThread.Type;

export const TrackerHandoffState = Schema.Struct({
  /** Done deciding was pressed and the agent has not picked the answers up yet. */
  waiting: Schema.Boolean,
  at: Schema.NullOr(Schema.String),
  /** "pending" or "stale" while the relay works; "sent" or "failed" once it reports. */
  delivery: Schema.NullOr(Schema.Literals(["pending", "stale", "sent", "failed"])),
  reason: Schema.NullOr(Schema.String),
});
export type TrackerHandoffState = typeof TrackerHandoffState.Type;

/** A release train this work waits for (tracker K8): its repo, the live check and how many wait. */
export const TrackerTrainWait = Schema.Struct({
  repo: Schema.String,
  check: Schema.String,
  waiting: Schema.Number,
});
export type TrackerTrainWait = typeof TrackerTrainWait.Type;

/**
 * Something outside the hub the work's agent waits on (tracker watches): today a pull
 * request merging. The hub host checks it and wakes the linked conversation.
 */
export const TrackerWatch = Schema.Struct({
  id: Schema.String,
  repo: Schema.String,
  number: Schema.Number,
  note: Schema.String,
  /** Set while snoozed: the hub holds the wake until then. */
  snoozedUntil: Schema.NullOr(Schema.String),
  /** After it fired: the wake's delivery, "pending" or "failed" (the hub retries). */
  delivery: Schema.NullOr(Schema.String),
});
export type TrackerWatch = typeof TrackerWatch.Type;

export const TrackerWorkDetail = Schema.Struct({
  host: Schema.String,
  hubUrl: Schema.String,
  fetchedAt: Schema.String,
  id: Schema.String,
  title: Schema.String,
  goal: Schema.String,
  /** The record's one-line summary when it has one; empty otherwise. */
  tagline: Schema.String,
  domain: Schema.NullOr(Schema.String),
  status: Schema.String,
  updated: Schema.NullOr(Schema.String),
  lastWork: Schema.NullOr(Schema.String),
  waitingOnYou: Schema.Boolean,
  progress: TrackerProgress,
  phases: Schema.Array(TrackerPhase),
  cards: Schema.Array(TrackerCard),
  briefs: Schema.Array(TrackerBrief),
  /** Documents the record lists, as paths inside the hub's project folder. */
  docs: Schema.Array(Schema.Struct({ label: Schema.String, path: Schema.String })),
  /** Set when the hub judges the record stale against its inputs; holds the hub's reasons. */
  needsReview: Schema.NullOr(Schema.Struct({ reasons: Schema.Array(Schema.String) })),
  /** Release trains the work is ready to ship on and still waits for; empty when none. */
  trains: Schema.Array(TrackerTrainWait),
  /** What the agent waits on outside the hub; empty when nothing. */
  watches: Schema.Array(TrackerWatch),
  /** The one conversation the hub delivers Eric's decisions to. */
  thread: Schema.NullOr(TrackerLinkedThread),
  /**
   * The hub's sentence for why no close may end this record now (a standing record),
   * or null. The sidebar shows it in place of Close Out; it never words its own.
   */
  closeRefusal: Schema.NullOr(Schema.String),
  /** Eric's last "Done deciding" and how its delivery went. */
  handoff: TrackerHandoffState,
});
export type TrackerWorkDetail = typeof TrackerWorkDetail.Type;

export const TrackerGetPortfolioInput = Schema.Struct({});
export type TrackerGetPortfolioInput = typeof TrackerGetPortfolioInput.Type;

export const TrackerGetWorkInput = Schema.Struct({ workId: TrackerWorkId });
export type TrackerGetWorkInput = typeof TrackerGetWorkInput.Type;

/** Asks the hub to start a new agent that owns the record; the host's relay creates its thread. */
export const TrackerStartAgentInput = Schema.Struct({
  workId: TrackerWorkId,
  /** One per press: the hub answers a repeated key with the same start and starts nothing new. */
  key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  /** Eric's note for the new agent. */
  request: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
  model: Schema.optionalKey(ModelSelection),
});
export type TrackerStartAgentInput = typeof TrackerStartAgentInput.Type;

export const TrackerAgentStart = Schema.Struct({
  host: Schema.String,
  /** The new agent's conversation; null while the host's relay is still creating it. */
  threadId: Schema.NullOr(Schema.String),
});
export type TrackerAgentStart = typeof TrackerAgentStart.Type;

export const TrackerThreadOwnerInput = Schema.Struct({ threadId: ThreadId });
export type TrackerThreadOwnerInput = typeof TrackerThreadOwnerInput.Type;

/** The live record a conversation on this host owns, or null when it owns none. */
export const TrackerThreadOwner = Schema.Struct({ workId: Schema.NullOr(Schema.String) });
export type TrackerThreadOwner = typeof TrackerThreadOwner.Type;

export const TrackerLinkThreadInput = Schema.Struct({
  workId: TrackerWorkId,
  threadId: ThreadId,
  title: Schema.String,
  /**
   * The thread the caller saw linked, or null for none. The hub keeps one link per
   * work item, so a stale view must not silently replace someone else's link.
   */
  expectedThreadId: Schema.NullOr(Schema.String),
});
export type TrackerLinkThreadInput = typeof TrackerLinkThreadInput.Type;

/** This conversation leaves the record it owns; the record then has no conversation. */
export const TrackerUnlinkThreadInput = Schema.Struct({
  workId: TrackerWorkId,
  threadId: ThreadId,
});
export type TrackerUnlinkThreadInput = typeof TrackerUnlinkThreadInput.Type;

/** What Eric read on a card; the hub write is refused when the card has moved on. */
export const TrackerCardSeen = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  title: Schema.String,
  ask: Schema.String,
  comments: Schema.Number,
});
export type TrackerCardSeen = typeof TrackerCardSeen.Type;

export const TrackerAnswerCardInput = Schema.Struct({
  workId: TrackerWorkId,
  card: TrackerCardSeen,
  /** null keeps the status (a comment only); a question ignores it. */
  status: Schema.NullOr(Schema.Literals(["open", "approved", "rejected"])),
  comment: Schema.String,
});
export type TrackerAnswerCardInput = typeof TrackerAnswerCardInput.Type;

export const TrackerDoneDecidingInput = Schema.Struct({
  workId: TrackerWorkId,
  /** Every card Eric saw; Done deciding is refused when any of them changed. */
  cards: Schema.Array(TrackerCardSeen),
});
export type TrackerDoneDecidingInput = typeof TrackerDoneDecidingInput.Type;

/**
 * Eric's cancel on one watch. There is no snooze here: he snoozes the T3 conversation,
 * and the tracker relay ends that snooze when the watch fires.
 */
export const TrackerUpdateWatchInput = Schema.Struct({
  workId: TrackerWorkId,
  watch: Schema.String,
  action: Schema.Literals(["cancel"]),
});
export type TrackerUpdateWatchInput = typeof TrackerUpdateWatchInput.Type;

export class TrackerHubError extends Schema.TaggedError<TrackerHubError>()("TrackerHubError", {
  reason: Schema.Literals([
    "unreachable",
    "refused",
    "notFound",
    "invalidResponse",
    "linkChanged",
    "cardChanged",
  ]),
  detail: TrimmedNonEmptyString,
}) {
  override get message(): string {
    return `Tracker hub ${this.reason}: ${this.detail}`;
  }
}
