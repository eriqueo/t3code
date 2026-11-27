import {
  TrackerHubError,
  type TrackerAnswerCardInput,
  type TrackerCard,
  type TrackerCardSeen,
  type TrackerDoneDecidingInput,
  type TrackerAgentStart,
  type TrackerGetWorkInput,
  type TrackerLinkedThread,
  type TrackerLinkThreadInput,
  type TrackerUnlinkThreadInput,
  type TrackerPortfolio,
  TRACKER_TERMINAL_STATUSES,
  type TrackerUpdateWatchInput,
  type TrackerStartAgentInput,
  type TrackerThreadOwner,
  type TrackerThreadOwnerInput,
  type TrackerWorkDetail,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

const HUB_TIMEOUT = "8 seconds";
// A start waits about 30 s for the relay to name the new thread, then reports it as still starting.
const START_POLLS = 30;
const START_POLL = "1 second";
const DEFAULT_HUB_URL = "http://hwc-work:8765";
// Records the hub will not change again; the Tracker shows work that can still move.
const TERMINAL_STATUSES = TRACKER_TERMINAL_STATUSES;

export class TrackerHub extends Context.Service<
  TrackerHub,
  {
    readonly portfolio: Effect.Effect<TrackerPortfolio, TrackerHubError>;
    readonly work: (
      input: TrackerGetWorkInput,
    ) => Effect.Effect<TrackerWorkDetail, TrackerHubError>;
    /** Fails when the hub cannot say; an unreachable hub never reads as "owns nothing". */
    readonly threadOwner: (
      input: TrackerThreadOwnerInput,
    ) => Effect.Effect<TrackerThreadOwner, TrackerHubError>;
    /** The hub starts the agent through this host's relay and moves the record to its thread. */
    readonly startAgent: (
      input: TrackerStartAgentInput,
    ) => Effect.Effect<TrackerAgentStart, TrackerHubError>;
    readonly linkThread: (
      input: TrackerLinkThreadInput,
    ) => Effect.Effect<TrackerLinkedThread, TrackerHubError>;
    /** This conversation leaves the record; the hub refuses when another one owns it. */
    readonly unlinkThread: (
      input: TrackerUnlinkThreadInput,
    ) => Effect.Effect<void, TrackerHubError>;
    /** Saves Eric's answer on one card, as the hub's own page does. */
    readonly answerCard: (
      input: TrackerAnswerCardInput,
    ) => Effect.Effect<TrackerWorkDetail, TrackerHubError>;
    /** Eric's "Done deciding": the hub queues his answers for the linked conversation. */
    readonly doneDeciding: (
      input: TrackerDoneDecidingInput,
    ) => Effect.Effect<TrackerWorkDetail, TrackerHubError>;
    /** Eric's cancel on a watch, as the hub's own page does. */
    readonly updateWatch: (
      input: TrackerUpdateWatchInput,
    ) => Effect.Effect<TrackerWorkDetail, TrackerHubError>;
  }
>()("t3/tracker/TrackerHub") {}

type Json = Readonly<Record<string, unknown>>;

const record = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
const list = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);
const text = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
const textOrNull = (value: unknown): string | null => {
  const read = text(value);
  return read === "" ? null : read;
};
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const progressOf = (value: unknown) => {
  const progress = record(value);
  return { done: count(progress.done), total: count(progress.total) };
};

export interface HubPortfolioSources {
  readonly portfolio: unknown;
  readonly attention: unknown;
  readonly observations: unknown;
}

export interface HubReadContext {
  readonly host: string;
  readonly hubUrl: string;
  readonly fetchedAt: string;
}

/** The hub's portfolio, attention and per-host link routes as one view. */
export const portfolioFromHub = (
  sources: HubPortfolioSources,
  context: HubReadContext,
): TrackerPortfolio => {
  const portfolio = record(sources.portfolio);
  const works = Object.values(record(portfolio.projects))
    .map(record)
    .filter((work) => !TERMINAL_STATUSES.has(text(work.status)))
    .map((work) => ({
      id: text(work.id),
      title: text(work.title) || text(work.id),
      goal: text(work.goal),
      domain: textOrNull(work.domain),
      status: text(work.status),
      state: text(work.state),
      openCards: count(work.open),
      waitingOnYou: work.waitingOnEric === true || count(work.open) > 0,
      overdue: work.overdue === true,
      lastWork: textOrNull(work.lastWork),
      progress: progressOf(work.progress),
    }))
    .filter((work) => work.id !== "");
  const shown = new Set(works.map((work) => work.id));
  return {
    ...context,
    today: text(portfolio.today),
    liveCap: typeof portfolio.liveCap === "number" ? portfolio.liveCap : null,
    liveProjects: count(record(portfolio.counts).projects),
    domains: list(portfolio.groups)
      .map(record)
      .map((group) => ({
        id: text(group.domain) || text(group.group),
        label: text(group.label) || text(group.domain),
        colour: textOrNull(group.colour),
        count: count(group.count),
        needYou: count(group.needYou),
        workIds: list(group.projects)
          .map(text)
          .filter((id) => shown.has(id)),
      })),
    works,
    attention: list(record(sources.attention).cards)
      .map(record)
      .map((card) => ({
        key: text(card.key),
        workId: text(card.project),
        workTitle: text(card.projectTitle),
        title: text(card.title),
        kind: text(card.kind),
        due: textOrNull(card.due),
        expired: card.expired === true,
      }))
      .filter((card) => card.key !== "" && card.workId !== ""),
    links: list(record(sources.observations).targets)
      .map(record)
      .map((target) => ({ workId: text(target.project), threadId: text(target.threadId) }))
      .filter((link) => link.workId !== "" && link.threadId !== ""),
    threads: threadRecords(portfolio, context.host),
  };
};

/**
 * Each conversation on `host` with the record it owns, so the sidebar can group by domain.
 * Finished records count too: their conversation is still tracked work, not loose. A thread
 * that owns several records takes the first that can still move, else the first finished.
 */
const threadRecords = (portfolio: Json, host: string): TrackerPortfolio["threads"] => {
  const labels = new Map<string, string>();
  for (const group of list(portfolio.groups).map(record)) {
    labels.set(text(group.domain) || text(group.group), text(group.label));
  }
  // The hub's domain list names every domain, including ones no live record uses.
  for (const domain of list(portfolio.domains).map(record)) {
    labels.set(text(domain.id), text(domain.label));
  }
  const chosen = new Map<string, { live: boolean; entry: TrackerPortfolio["threads"][number] }>();
  for (const work of Object.values(record(portfolio.projects)).map(record)) {
    const thread = record(work.thread);
    const threadId = text(thread.threadId);
    const domain = text(work.domain);
    if (threadId === "" || text(thread.host) !== host || text(work.id) === "" || domain === "") {
      continue;
    }
    const live = !TERMINAL_STATUSES.has(text(work.status));
    const current = chosen.get(threadId);
    if (current !== undefined && (current.live || !live)) continue;
    chosen.set(threadId, {
      live,
      entry: {
        threadId,
        workId: text(work.id),
        domain,
        domainLabel: labels.get(domain) || domain,
        subdomain: textOrNull(work.subdomain),
      },
    });
  }
  return [...chosen.values()].map(({ entry }) => entry);
};

/**
 * A linked conversation carries its work's title, so the thread list and the tracker name
 * the same thing. Maps each linked thread to that title. The portfolio lists only work
 * that can still move, so a link to finished work leaves the thread's title alone. A thread
 * linked to several works takes the first the hub lists, so it cannot alternate.
 */
export const linkedWorkTitles = (
  portfolio: Pick<TrackerPortfolio, "links" | "works">,
): ReadonlyMap<string, string> => {
  const titleByWork = new Map(portfolio.works.map((work) => [work.id, work.title.trim()]));
  const titles = new Map<string, string>();
  for (const link of portfolio.links) {
    const title = titleByWork.get(link.workId) ?? "";
    if (title !== "" && !titles.has(link.threadId)) titles.set(link.threadId, title);
  }
  return titles;
};

/**
 * The last thread-to-work-title map the hub gave this host. Title generation reads it so a
 * linked thread keeps its work's title; the default knows no links.
 */
export class LinkedWorkTitles extends Context.Reference<{
  readonly titleFor: (threadId: string) => string | undefined;
  readonly replace: (titles: ReadonlyMap<string, string>) => void;
}>("t3/tracker/LinkedWorkTitles", {
  defaultValue: () => ({ titleFor: () => undefined, replace: () => undefined }),
}) {}

export const layerLinkedWorkTitles = Layer.sync(LinkedWorkTitles, () => {
  let current: ReadonlyMap<string, string> = new Map();
  return {
    titleFor: (threadId) => current.get(threadId),
    replace: (titles) => {
      current = titles;
    },
  };
});

const linkedThreadFromHub = (value: unknown): TrackerLinkedThread | null => {
  const thread = record(value);
  const threadId = text(thread.threadId);
  return threadId === ""
    ? null
    : {
        host: text(thread.host),
        threadId,
        title: text(thread.title),
        linkedAt: textOrNull(thread.linkedAt),
      };
};

/** The hub's project view; `null` when the body is not a project record. */
export const workFromHub = (value: unknown, context: HubReadContext): TrackerWorkDetail | null => {
  const work = record(value);
  const id = text(work.project);
  if (id === "") return null;
  const clock = record(work.clock);
  const cards = list(work.cards).map(record);
  return {
    ...context,
    id,
    title: text(work.title) || id,
    goal: text(work.goal),
    tagline: text(work.tagline),
    domain: textOrNull(work.domain),
    // The hub stores no status on a record that was never parked or closed.
    status: text(work.status) || "active",
    updated: textOrNull(work.updated),
    lastWork: textOrNull(clock.lastWork),
    waitingOnYou:
      clock.waitingOnEric === true || cards.some((card) => text(card.status) === "open"),
    progress: progressOf(clock.progress),
    phases: list(work.phases)
      .map(record)
      .map((phase) => ({
        id: text(phase.id),
        title: text(phase.title),
        status: text(phase.status),
        planned: textOrNull(phase.planned),
        done: textOrNull(phase.done),
        terminal: phase.terminal === true,
        wait: textOrNull(record(phase.wait).what ?? phase.wait),
      })),
    cards: cards.map((card) => ({
      id: text(card.id),
      kind: text(card.kind),
      title: text(card.title),
      ask: text(card.ask),
      status: text(card.status),
      phase: text(card.phase),
      context: text(card.context),
      plan: text(card.plan),
      risk: text(card.risk),
      recommend: text(card.recommend),
      decidedAt: textOrNull(card.decidedAt),
      comments: list(card.comments)
        .map(record)
        .map((comment) => ({ at: textOrNull(comment.at), text: text(comment.text) })),
      answerable: !card.bulk && !card.review,
    })),
    briefs: list(work.briefs)
      .map(record)
      .map((brief) => ({
        id: text(brief.id),
        kind: text(brief.kind),
        title: text(brief.title),
        summary: text(brief.summary),
        // Older briefs carry a full timestamp; the day is what the views show.
        date: textOrNull(brief.date)?.slice(0, 10) ?? null,
        wrong: list(brief.wrong).map((entry) => text(entry) || text(record(entry).title)),
      })),
    docs: list(work.docs)
      .map(record)
      .map((doc) => ({ label: text(doc.label) || text(doc.path), path: text(doc.path) }))
      .filter((doc) => doc.path !== ""),
    needsReview: needsReviewFromHub(work.freshness),
    // Tracker K8: entries the train has not taken yet (result state "ready").
    trains: list(work.ready)
      .map(record)
      .filter((entry) => text(record(entry.result).state) === "ready" && text(entry.repo) !== "")
      .map((entry) => ({
        repo: text(entry.repo),
        check: text(entry.check),
        waiting: count(entry.waiting),
      })),
    // Tracker watches: the hub lists those not yet done. A hub without them sends none.
    watches: list(work.watches)
      .map(record)
      .filter((entry) => text(entry.id) !== "")
      .map((entry) => ({
        id: text(entry.id),
        repo: text(entry.repo),
        number: count(entry.number),
        note: text(entry.note),
        snoozedUntil: entry.snoozed === true ? textOrNull(entry.snoozedUntil) : null,
        delivery: textOrNull(entry.delivery),
      })),
    thread: linkedThreadFromHub(record(work.handoff).thread),
    closeRefusal: textOrNull(work.closeRefusal),
    handoff: handoffFromHub(work.handoff),
  };
};

/** The hub's delivery record for Done deciding, as the hub page words its states. */
const handoffFromHub = (value: unknown): TrackerWorkDetail["handoff"] => {
  const handoff = record(value);
  const delivery = record(handoff.delivery);
  const state = text(delivery.state);
  return {
    waiting: handoff.waiting === true,
    at: textOrNull(handoff.at),
    delivery:
      handoff.delivery === null || handoff.delivery === undefined
        ? null
        : state === "pending" || state === "stale"
          ? state
          : delivery.ok === true
            ? "sent"
            : "failed",
    reason: textOrNull(delivery.reason),
  };
};

/** The card as Eric last read it, compared on what an answer depends on. */
const cardSeen = (card: TrackerCard): TrackerCardSeen => ({
  id: card.id,
  status: card.status,
  title: card.title,
  ask: card.ask,
  comments: card.comments.length,
});

const sameSeen = (left: TrackerCardSeen, right: TrackerCardSeen) =>
  left.id === right.id &&
  left.status === right.status &&
  left.title === right.title &&
  left.ask === right.ask &&
  left.comments === right.comments;

/** The hub's refusal, in its own words when it gave them. Legacy routes send `{"error": code}`. */
const hubRefusal = (body: unknown): { code: string; detail: string } => {
  const raw = record(body).error;
  if (typeof raw === "string") return { code: raw, detail: raw };
  const error = record(raw);
  return { code: text(error.code), detail: text(error.detail) || text(error.code) };
};

/** The owner an `owned-by` refusal names, wherever this hub version puts it. */
const ownerFromRefusal = (body: unknown): TrackerLinkedThread | null => {
  const reply = record(body);
  const error = record(reply.error);
  for (const source of [error.detail, error.owner, reply.owner, reply]) {
    const owner = linkedThreadFromHub(source);
    if (owner !== null) return owner;
  }
  return null;
};

/**
 * The live record `threadId` on `host` owns, or null. A thread that owns only finished
 * records owns nothing a new agent could pick up.
 */
const threadOwnerFromHub = (portfolio: unknown, host: string, threadId: string): string | null => {
  for (const work of Object.values(record(record(portfolio).projects)).map(record)) {
    const thread = record(work.thread);
    if (
      text(thread.threadId) === threadId &&
      text(thread.host) === host &&
      text(work.id) !== "" &&
      !TERMINAL_STATUSES.has(text(work.status))
    ) {
      return text(work.id);
    }
  }
  return null;
};

/** Plain words for the hub's refusals of a start. */
const startRefusal = (code: string, detail: string, host: string): string => {
  switch (code) {
    case "agent-start-pending":
      return "Another agent is already starting for this record. Wait for it to appear, then try again.";
    case "agent-start-unavailable":
      return `No tracker relay on ${host} can start agents right now. Check that the relay is running there.`;
    case "agent-model-unavailable":
      return `The tracker relay on ${host} is too old to take a model choice. Update the relay, or start without choosing a model.`;
    case "bad-start":
      return "The tracker hub refused the start as malformed. Shorten the note and try again.";
    default:
      return `The tracker hub did not start the agent: ${detail || "no reason given"}.`;
  }
};

/** The hub reports `matched`, `needs_review` or `unknown`; only `needs_review` asks for action. */
const needsReviewFromHub = (value: unknown): TrackerWorkDetail["needsReview"] => {
  const freshness = record(value);
  if (text(freshness.state) !== "needs_review") return null;
  const labels = list(freshness.reasonLabels)
    .map(text)
    .filter((label) => label !== "");
  return { reasons: labels.length > 0 ? labels : list(freshness.reasons).map(text) };
};

const make = Effect.fn("TrackerHub.make")(function* (hubUrl: string) {
  const client = yield* HttpClient.HttpClient;
  const host = yield* HostProcess.Hostname;

  const refused = (path: string) => () =>
    new TrackerHubError({
      reason: "refused",
      detail: `The tracker hub at ${hubUrl} refused ${path}.`,
    });

  const send = (path: string, body?: unknown) => {
    const url = `${hubUrl}${path}`;
    const request =
      body === undefined
        ? HttpClientRequest.get(url)
        : HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body));
    return client.execute(request).pipe(
      Effect.mapError(
        () =>
          new TrackerHubError({
            reason: "unreachable",
            detail: `Could not reach the tracker hub at ${hubUrl}.`,
          }),
      ),
      Effect.flatMap((response) =>
        response.status === 404
          ? Effect.fail(
              new TrackerHubError({
                reason: "notFound",
                detail: `The tracker hub has no record at ${path}.`,
              }),
            )
          : HttpClientResponse.filterStatusOk(response).pipe(Effect.mapError(refused(path))),
      ),
    );
  };

  const json = (path: string, body?: unknown) =>
    send(path, body).pipe(
      Effect.flatMap((response) => Effect.mapError(response.json, refused(path))),
      Effect.timeoutOrElse({
        duration: HUB_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new TrackerHubError({
              reason: "unreachable",
              detail: `The tracker hub at ${hubUrl} took too long to answer.`,
            }),
          ),
      }),
      Effect.scoped,
    );

  const context = Effect.map(DateTime.now, (now) => ({
    host,
    hubUrl,
    fetchedAt: DateTime.formatIso(now),
  }));

  const work = Effect.fn("TrackerHub.work")(function* ({ workId }: TrackerGetWorkInput) {
    const body = yield* json(`/api/projects/${encodeURIComponent(workId)}`);
    const detail = workFromHub(body, yield* context);
    if (detail === null) {
      return yield* new TrackerHubError({
        reason: "invalidResponse",
        detail: `The tracker hub answered ${workId} with something that is not a record.`,
      });
    }
    return detail;
  });

  // A write that may have reached the hub is never retried blindly: the caller reloads.
  const post = (path: string, body: unknown, method: "POST" | "DELETE" = "POST") =>
    client
      .execute(
        (method === "DELETE" ? HttpClientRequest.delete : HttpClientRequest.post)(
          `${hubUrl}${path}`,
        ).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
      )
      .pipe(
        Effect.mapError(
          () =>
            new TrackerHubError({
              reason: "unreachable",
              detail: `Could not reach the tracker hub at ${hubUrl}. Reload to see whether it was saved.`,
            }),
        ),
        Effect.flatMap((response) =>
          response.json.pipe(
            Effect.orElseSucceed(() => null),
            Effect.map((json) => ({
              ok: response.status >= 200 && response.status < 300,
              status: response.status,
              json,
            })),
          ),
        ),
        Effect.timeoutOrElse({
          duration: HUB_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new TrackerHubError({
                reason: "unreachable",
                detail: `The tracker hub at ${hubUrl} took too long to answer. Reload to see whether it was saved.`,
              }),
            ),
        }),
        Effect.scoped,
      );

  /**
   * One human write guarded twice, as the Herdr pane does: the cards must still read as Eric
   * saw them, and the hub refuses a revision that moved. A move that leaves his cards alone
   * is retried once on the new revision.
   */
  const humanWrite = Effect.fn("TrackerHub.humanWrite")(function* (
    workId: string,
    seen: ReadonlyArray<TrackerCardSeen>,
    /** Done deciding covers every card, so one Eric never saw also refuses it. */
    everyCard: boolean,
    path: string,
    body: Record<string, unknown>,
  ) {
    for (let attempt = 0; ; attempt += 1) {
      const revision = text(
        record(yield* json(`/api/v1/projects/${encodeURIComponent(workId)}`)).revision,
      );
      const fresh = yield* work({ workId });
      const unseen = everyCard
        ? fresh.cards.find((card) => !seen.some((entry) => entry.id === card.id))
        : undefined;
      if (unseen !== undefined) {
        return yield* new TrackerHubError({
          reason: "cardChanged",
          detail: `A new decision arrived: ${unseen.title || unseen.id}. Look at it before Done deciding.`,
        });
      }
      for (const card of seen) {
        const now = fresh.cards.find((entry) => entry.id === card.id);
        if (now === undefined || !sameSeen(cardSeen(now), card)) {
          return yield* new TrackerHubError({
            reason: "cardChanged",
            detail: `${card.title || card.id} changed while you read it. Read it again; your text is kept.`,
          });
        }
      }
      const reply = yield* post(path, {
        schemaVersion: 1,
        expectedRevision: revision,
        ...body,
      });
      if (reply.ok) return yield* work({ workId });
      const refusal = hubRefusal(reply.json);
      if (refusal.code === "stale-revision" && attempt === 0) continue;
      return yield* new TrackerHubError({
        reason: refusal.code === "stale-revision" ? "cardChanged" : "refused",
        detail:
          refusal.code === "stale-revision"
            ? "The project keeps changing. Try again."
            : `The tracker hub did not save it: ${refusal.detail || "no reason given"}.`,
      });
    }
  });

  return TrackerHub.of({
    portfolio: Effect.all(
      {
        portfolio: json("/api/portfolio"),
        attention: json("/api/attention"),
        observations: json(`/api/observations?host=${encodeURIComponent(host)}`),
      },
      { concurrency: 3 },
    ).pipe(
      Effect.flatMap((sources) => Effect.map(context, (read) => portfolioFromHub(sources, read))),
      Effect.withSpan("TrackerHub.portfolio"),
    ),
    work,
    threadOwner: Effect.fn("TrackerHub.threadOwner")(function* ({ threadId }) {
      const portfolio = record(yield* json("/api/portfolio"));
      if (typeof portfolio.projects !== "object" || portfolio.projects === null) {
        return yield* new TrackerHubError({
          reason: "invalidResponse",
          detail: "The tracker hub's portfolio lists no records, so ownership is unknown.",
        });
      }
      return { workId: threadOwnerFromHub(portfolio, host, threadId) };
    }),
    startAgent: Effect.fn("TrackerHub.startAgent")(function* (input) {
      const path = `/api/projects/${encodeURIComponent(input.workId)}/start`;
      const body = {
        schemaVersion: 1,
        app: "t3",
        host,
        key: input.key,
        ...(input.request === undefined || input.request.trim() === ""
          ? {}
          : { request: input.request }),
        ...(input.model === undefined ? {} : { model: input.model }),
      };
      // Repeating the same key returns the stored start and starts nothing new, so asking
      // again is how the relay's progress is read.
      const starting = { host, threadId: null };
      for (let poll = 0; ; poll += 1) {
        // Once the hub took the start, a failed progress read means "still starting", not failure.
        const reply =
          poll === 0
            ? yield* post(path, body)
            : yield* Effect.orElseSucceed(post(path, body), () => null);
        if (reply === null || (poll > 0 && !reply.ok)) return starting;
        if (!reply.ok) {
          if (reply.status === 404) {
            return yield* new TrackerHubError({
              reason: "notFound",
              detail: `The tracker hub has no record ${input.workId}.`,
            });
          }
          const refusal = hubRefusal(reply.json);
          return yield* new TrackerHubError({
            reason: "refused",
            detail: startRefusal(refusal.code, refusal.detail, host),
          });
        }
        const delivery = record(record(reply.json).delivery);
        const state = text(delivery.state);
        if (state === "failed") {
          return yield* new TrackerHubError({
            reason: "refused",
            detail: `The agent did not start: ${text(delivery.reason) || "the relay gave no reason"}.`,
          });
        }
        if (state !== "pending" && state !== "delivered") {
          return yield* new TrackerHubError({
            reason: "invalidResponse",
            detail: "The tracker hub did not confirm the start.",
          });
        }
        const threadId = textOrNull(delivery.threadId);
        const started = { host: text(delivery.host) || host, threadId };
        if (threadId !== null || poll + 1 >= START_POLLS) return started;
        yield* Effect.sleep(START_POLL);
      }
    }),
    linkThread: Effect.fn("TrackerHub.linkThread")(function* (input) {
      // Eric's Link moves ownership (`move`), so the hub would replace any owner. Compare
      // first, so a stale view never moves a link he did not see. Two callers can still
      // pass this check together; the hub then keeps the later one.
      const current = (yield* work({ workId: input.workId })).thread;
      if ((current?.threadId ?? null) !== input.expectedThreadId) {
        return yield* new TrackerHubError({
          reason: "linkChanged",
          detail:
            current === null
              ? "The link was removed while you were looking. Reload and try again."
              : `Another conversation was linked meanwhile: ${current.title || current.threadId}.`,
        });
      }
      const path = `/api/projects/${encodeURIComponent(input.workId)}/thread`;
      const reply = yield* post(path, {
        host,
        id: input.threadId,
        title: input.title,
        move: true,
      });
      if (!reply.ok) {
        const refusal = hubRefusal(reply.json);
        if (refusal.code !== "owned-by") {
          return yield* new TrackerHubError({
            reason: "refused",
            detail: `The tracker hub did not link it: ${refusal.detail || "no reason given"}.`,
          });
        }
        // An older hub names no owner in its refusal; the record does.
        const owner =
          ownerFromRefusal(reply.json) ?? (yield* work({ workId: input.workId })).thread;
        return yield* new TrackerHubError({
          reason: "linkChanged",
          detail:
            owner === null
              ? "Another conversation owns this record. Reload and try again."
              : `This record belongs to ${owner.title || owner.threadId}. The hub kept that link.`,
        });
      }
      const linked = linkedThreadFromHub(reply.json);
      if (linked === null) {
        return yield* new TrackerHubError({
          reason: "invalidResponse",
          detail: "The tracker hub did not confirm the link.",
        });
      }
      return linked;
    }),
    unlinkThread: Effect.fn("TrackerHub.unlinkThread")(function* (input) {
      const reply = yield* post(`/api/projects/${encodeURIComponent(input.workId)}/unlink`, {
        host,
        id: input.threadId,
      });
      if (!reply.ok) {
        const refusal = hubRefusal(reply.json);
        return yield* new TrackerHubError({
          reason: refusal.code === "owned-by" ? "linkChanged" : "refused",
          detail:
            refusal.code === "owned-by"
              ? "Another conversation owns this record, so this one has nothing to unlink."
              : `The tracker hub did not unlink it: ${refusal.detail || "no reason given"}.`,
        });
      }
    }),
    answerCard: Effect.fn("TrackerHub.answerCard")((input) =>
      humanWrite(
        input.workId,
        [input.card],
        false,
        `/api/v1/projects/${encodeURIComponent(input.workId)}/cards/${encodeURIComponent(input.card.id)}/answer`,
        {
          ...(input.status === null ? {} : { status: input.status }),
          ...(input.comment.trim() === "" ? {} : { comment: input.comment }),
        },
      ),
    ),
    doneDeciding: Effect.fn("TrackerHub.doneDeciding")((input) =>
      humanWrite(
        input.workId,
        input.cards,
        true,
        `/api/v1/projects/${encodeURIComponent(input.workId)}/handoff`,
        {},
      ),
    ),
    updateWatch: Effect.fn("TrackerHub.updateWatch")(function* (input) {
      const reply = yield* post(
        `/api/v1/watches/${encodeURIComponent(input.workId)}`,
        { schemaVersion: 1, watch: input.watch },
        "DELETE",
      );
      if (!reply.ok) {
        const refusal = hubRefusal(reply.json);
        return yield* new TrackerHubError({
          reason: refusal.code === "no-such-watch" ? "notFound" : "refused",
          detail:
            refusal.code === "no-such-watch"
              ? "That watch is already gone: it fired or was cancelled."
              : `The tracker hub did not save it: ${refusal.detail || "no reason given"}.`,
        });
      }
      return yield* work({ workId: input.workId });
    }),
  });
});

const hubUrlConfig = Config.String("T3CODE_TRACKER_HUB_URL").pipe(
  // The harness tools on the same host already read TRACKER_URL.
  Config.orElse(() => Config.String("TRACKER_URL")),
  Config.withDefault(DEFAULT_HUB_URL),
  Config.map((url) => url.replace(/\/+$/, "")),
);

export const layer = Layer.effect(TrackerHub, Effect.flatMap(hubUrlConfig, make));

export const layerWithHubUrl = (hubUrl: string) => Layer.effect(TrackerHub, make(hubUrl));
