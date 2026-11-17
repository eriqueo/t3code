import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * The tracker hub owns these records. T3 reads them through its own server so a
 * remote browser never needs a route to the hub, and never stores a copy.
 */
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
  /** `task`, `project`, or a kind this client does not know yet. */
  kind: Schema.NullOr(Schema.String),
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

export const TrackerCard = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  title: Schema.String,
  ask: Schema.String,
  status: Schema.String,
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

export const TrackerWorkDetail = Schema.Struct({
  host: Schema.String,
  hubUrl: Schema.String,
  fetchedAt: Schema.String,
  id: Schema.String,
  title: Schema.String,
  goal: Schema.String,
  domain: Schema.NullOr(Schema.String),
  kind: Schema.NullOr(Schema.String),
  status: Schema.String,
  updated: Schema.NullOr(Schema.String),
  lastWork: Schema.NullOr(Schema.String),
  waitingOnYou: Schema.Boolean,
  progress: TrackerProgress,
  phases: Schema.Array(TrackerPhase),
  cards: Schema.Array(TrackerCard),
  briefs: Schema.Array(TrackerBrief),
  /** Set when the hub judges the record stale against its inputs; holds the hub's reasons. */
  needsReview: Schema.NullOr(Schema.Struct({ reasons: Schema.Array(Schema.String) })),
  /** The one conversation the hub delivers Eric's decisions to. */
  thread: Schema.NullOr(TrackerLinkedThread),
});
export type TrackerWorkDetail = typeof TrackerWorkDetail.Type;

export const TrackerGetPortfolioInput = Schema.Struct({});
export type TrackerGetPortfolioInput = typeof TrackerGetPortfolioInput.Type;

export const TrackerGetWorkInput = Schema.Struct({ workId: TrackerWorkId });
export type TrackerGetWorkInput = typeof TrackerGetWorkInput.Type;

export const TrackerLaunchPrompt = Schema.Struct({ workId: Schema.String, text: Schema.String });
export type TrackerLaunchPrompt = typeof TrackerLaunchPrompt.Type;

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

export class TrackerHubError extends Schema.TaggedError<TrackerHubError>()("TrackerHubError", {
  reason: Schema.Literals(["unreachable", "refused", "notFound", "invalidResponse", "linkChanged"]),
  detail: TrimmedNonEmptyString,
}) {
  override get message(): string {
    return `Tracker hub ${this.reason}: ${this.detail}`;
  }
}
