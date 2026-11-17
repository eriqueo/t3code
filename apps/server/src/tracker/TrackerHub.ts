import {
  TrackerHubError,
  type TrackerGetWorkInput,
  type TrackerLaunchPrompt,
  type TrackerLinkedThread,
  type TrackerLinkThreadInput,
  type TrackerPortfolio,
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
const DEFAULT_HUB_URL = "http://hwc-work:8765";
// Records the hub will not change again; the Tracker shows work that can still move.
const TERMINAL_STATUSES = new Set(["complete", "archived", "superseded", "dropped", "retired"]);

export class TrackerHub extends Context.Service<
  TrackerHub,
  {
    readonly portfolio: Effect.Effect<TrackerPortfolio, TrackerHubError>;
    readonly work: (
      input: TrackerGetWorkInput,
    ) => Effect.Effect<TrackerWorkDetail, TrackerHubError>;
    readonly launchPrompt: (
      input: TrackerGetWorkInput,
    ) => Effect.Effect<TrackerLaunchPrompt, TrackerHubError>;
    readonly linkThread: (
      input: TrackerLinkThreadInput,
    ) => Effect.Effect<TrackerLinkedThread, TrackerHubError>;
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
      kind: textOrNull(work.kind),
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
  };
};

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
    kind: textOrNull(work.kind),
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
    thread: linkedThreadFromHub(record(work.handoff).thread),
  };
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
    launchPrompt: Effect.fn("TrackerHub.launchPrompt")(function* ({ workId }) {
      const path = `/api/projects/${encodeURIComponent(workId)}/prompt`;
      const prompt = yield* send(path).pipe(
        Effect.flatMap((response) => Effect.mapError(response.text, refused(path))),
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
      return { workId, text: prompt };
    }),
    linkThread: Effect.fn("TrackerHub.linkThread")(function* (input) {
      // The hub's link route overwrites without a guard, so compare first. Two
      // callers can still pass this check together; the hub then keeps the later one.
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
      const linked = linkedThreadFromHub(
        yield* json(`/api/projects/${encodeURIComponent(input.workId)}/thread`, {
          host,
          id: input.threadId,
          title: input.title,
        }),
      );
      if (linked === null) {
        return yield* new TrackerHubError({
          reason: "invalidResponse",
          detail: "The tracker hub did not confirm the link.",
        });
      }
      return linked;
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
