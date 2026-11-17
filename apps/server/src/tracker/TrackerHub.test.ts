import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import { describe } from "vite-plus/test";

import * as TrackerHub from "./TrackerHub.ts";

const HUB = "http://hub.test";
const context = { host: "hwc-laptop", hubUrl: HUB, fetchedAt: "2026-11-16T00:00:00.000Z" };

const project = (thread: unknown) => ({
  project: "t3-tracker",
  title: "T3 chats linked to trackers",
  kind: "project",
  domain: "hwc",
  goal: "Goal",
  status: "active",
  phases: [
    { id: "P1", title: "Settle", status: "done", done: "2026-11-16" },
    { id: "P2", title: "Build", status: "waiting", wait: { what: "Eric's review" } },
    { id: "P3", title: "Ship", status: "next", planned: "2026-11-21", terminal: true },
  ],
  cards: [
    { id: 1, kind: "question", title: "Layout", ask: "Choose", status: "open" },
    { id: "2", kind: "decision", title: "Old", ask: "Chosen", status: "done" },
  ],
  briefs: [
    {
      id: "run-1",
      kind: "work",
      title: "Run",
      summary: "Did it",
      date: "2026-11-16",
      wrong: ["x"],
    },
  ],
  handoff: { thread },
  clock: { lastWork: "2026-11-16", waitingOnEric: false, progress: { done: 1, total: 3 } },
});

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

const hubWith = (routes: Record<string, () => Response>) => {
  const sent: Array<Sent> = [];
  const client = HttpClient.make((request) => {
    const path = request.url.slice(HUB.length);
    sent.push({
      method: request.method,
      url: path,
      body:
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : null,
    });
    const route = routes[`${request.method} ${path}`];
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, route ? route() : new Response(null, { status: 404 })),
    );
  });
  const layer = TrackerHub.layerWithHubUrl(HUB).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
  );
  return { sent, layer };
};

describe("TrackerHub", () => {
  it("keeps work that can still move and scopes links to threads that exist", () => {
    const portfolio = TrackerHub.portfolioFromHub(
      {
        portfolio: {
          today: "2026-11-16",
          liveCap: 20,
          counts: { projects: 2 },
          groups: [
            {
              domain: "hwc",
              label: "HWC",
              colour: "#d08770",
              count: 2,
              needYou: 1,
              projects: ["a", "done"],
            },
          ],
          projects: {
            a: {
              id: "a",
              title: "A",
              status: "active",
              state: "ok",
              open: 1,
              progress: { done: 1, total: 4 },
            },
            done: { id: "done", title: "Done", status: "complete", state: "complete" },
            parked: { id: "parked", title: "", status: "parked", state: "ok" },
          },
        },
        attention: {
          cards: [{ key: "k", project: "a", projectTitle: "A", title: "Decide", kind: "card" }],
        },
        observations: {
          targets: [
            { project: "a", threadId: "thread-1" },
            { project: "parked", threadId: null },
          ],
        },
      },
      context,
    );

    assert.deepStrictEqual(
      portfolio.works.map((work) => [work.id, work.title, work.waitingOnYou]),
      [
        ["a", "A", true],
        ["parked", "parked", false],
      ],
    );
    assert.deepStrictEqual(portfolio.domains[0]?.workIds, ["a"]);
    assert.deepStrictEqual(portfolio.links, [{ workId: "a", threadId: "thread-1" }]);
    assert.strictEqual(portfolio.attention[0]?.workId, "a");
  });

  it("reads phases, waits, cards and the linked thread from a project record", () => {
    const work = TrackerHub.workFromHub(
      project({ host: "hwc-laptop", threadId: "thread-1", title: "Chat" }),
      context,
    );

    assert.deepStrictEqual(work?.progress, { done: 1, total: 3 });
    assert.strictEqual(work?.phases[1]?.wait, "Eric's review");
    assert.strictEqual(work?.phases[2]?.terminal, true);
    assert.strictEqual(work?.cards[0]?.id, "1");
    assert.strictEqual(work?.waitingOnYou, true);
    assert.strictEqual(work?.thread?.threadId, "thread-1");
    assert.strictEqual(TrackerHub.workFromHub({ error: "not-found" }, context), null);
  });

  it("reads a never-transitioned task as active and dates a brief by its day", () => {
    const work = TrackerHub.workFromHub(
      {
        project: "task",
        kind: "task",
        briefs: [{ id: "run-1", date: "2026-11-14T05:35:04.165862+00:00" }],
      },
      context,
    );

    assert.strictEqual(work?.status, "active");
    assert.strictEqual(work?.briefs[0]?.date, "2026-11-14");
    assert.strictEqual(work?.needsReview, null);
  });

  it("flags review only for the hub's needs_review state, with its reason labels", () => {
    // Shape captured from the live hub record for t3-tracker on 2026-11-17.
    const stale = {
      state: "needs_review",
      label: "record needs review",
      reasons: ["checkout-head-changed"],
      reasonLabels: ["checkout revision differs from the handoff"],
      structuralOnly: true,
    };
    const read = (freshness: unknown) =>
      TrackerHub.workFromHub({ project: "p", freshness }, context)?.needsReview;

    assert.deepStrictEqual(read(stale), {
      reasons: ["checkout revision differs from the handoff"],
    });
    assert.deepStrictEqual(read({ state: "needs_review", reasons: ["missing-handoff"] }), {
      reasons: ["missing-handoff"],
    });
    assert.strictEqual(read({ ...stale, state: "matched" }), null);
    assert.strictEqual(read({ ...stale, state: "unknown" }), null);
    assert.strictEqual(read("needs_review"), null);
  });

  it.effect("links a thread when the caller saw the current link", () => {
    const hub = hubWith({
      "GET /api/projects/t3-tracker": () => Response.json(project(null)),
      "POST /api/projects/t3-tracker/thread": () =>
        Response.json({ host: "hwc-laptop", threadId: "thread-2", title: "New", linkedAt: "now" }),
    });
    return Effect.gen(function* () {
      const tracker = yield* TrackerHub.TrackerHub;
      const linked = yield* tracker.linkThread({
        workId: "t3-tracker",
        threadId: "thread-2" as never,
        title: "New",
        expectedThreadId: null,
      });

      assert.strictEqual(linked.threadId, "thread-2");
      assert.strictEqual(hub.sent[1]?.method, "POST");
      assert.deepStrictEqual(hub.sent[1]?.body, {
        host: "hwc-laptop",
        id: "thread-2",
        title: "New",
      });
    }).pipe(Effect.provide(hub.layer));
  });

  it.effect("refuses to replace a link the caller has not seen", () => {
    const hub = hubWith({
      "GET /api/projects/t3-tracker": () =>
        Response.json(project({ host: "hwc-work", threadId: "other", title: "Other chat" })),
    });
    return Effect.gen(function* () {
      const tracker = yield* TrackerHub.TrackerHub;
      const error = yield* Effect.flip(
        tracker.linkThread({
          workId: "t3-tracker",
          threadId: "thread-2" as never,
          title: "New",
          expectedThreadId: null,
        }),
      );

      assert.strictEqual(error.reason, "linkChanged");
      assert.deepStrictEqual(
        hub.sent.map((request) => request.method),
        ["GET"],
      );
    }).pipe(Effect.provide(hub.layer));
  });

  it.effect("reports a missing record as not found", () => {
    const hub = hubWith({});
    return Effect.gen(function* () {
      const tracker = yield* TrackerHub.TrackerHub;
      const error = yield* Effect.flip(tracker.work({ workId: "gone" }));

      assert.strictEqual(error.reason, "notFound");
    }).pipe(Effect.provide(hub.layer));
  });
});
