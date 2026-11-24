import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";
import * as HostProcess from "@t3tools/shared/HostProcess";
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

/** A route answering `null` drops the connection, as an unreachable hub does. */
const hubWith = (routes: Record<string, () => Response | null>) => {
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
    const response = route ? route() : new Response(null, { status: 404 });
    return response === null
      ? Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause: new Error("refused") }),
          }),
        )
      : Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });
  const layer = TrackerHub.layerWithHubUrl(HUB).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    // The hub keys links by host; pin it so the test passes on any machine.
    Layer.provide(Layer.succeed(HostProcess.Hostname, context.host)),
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

  it("gives each thread on this host its record's domain, preferring work that can still move", () => {
    const owner = (threadId: string, host = context.host) => ({ host, threadId, title: "" });
    const portfolio = TrackerHub.portfolioFromHub(
      {
        portfolio: {
          domains: [
            { id: "datax", label: "DataX" },
            { id: "infra", label: "Infra" },
          ],
          groups: [{ domain: "hwc", label: "HWC" }],
          projects: {
            old: { id: "old", status: "complete", domain: "infra", thread: owner("shared") },
            live: {
              id: "live",
              status: "active",
              domain: "datax",
              subdomain: "integrations",
              thread: owner("shared"),
            },
            parked: { id: "parked", status: "parked", domain: "hwc", thread: owner("legacy") },
            done: { id: "done", status: "complete", domain: "infra", thread: owner("finished") },
            elsewhere: {
              id: "elsewhere",
              status: "active",
              domain: "infra",
              thread: owner("laptop-thread", "hwc-work"),
            },
            untitled: { id: "untitled", status: "active", domain: "infra", thread: null },
            nodomain: { id: "nodomain", status: "active", thread: owner("loose") },
            unlabelled: {
              id: "unlabelled",
              status: "active",
              domain: "gauntlets",
              thread: owner("g"),
            },
          },
        },
        attention: {},
        observations: {},
      },
      context,
    );

    assert.deepStrictEqual(portfolio.threads, [
      {
        threadId: "shared",
        workId: "live",
        domain: "datax",
        domainLabel: "DataX",
        subdomain: "integrations",
      },
      { threadId: "legacy", workId: "parked", domain: "hwc", domainLabel: "HWC", subdomain: null },
      {
        threadId: "finished",
        workId: "done",
        domain: "infra",
        domainLabel: "Infra",
        subdomain: null,
      },
      {
        threadId: "g",
        workId: "unlabelled",
        domain: "gauntlets",
        domainLabel: "gauntlets",
        subdomain: null,
      },
    ]);
  });

  it("names each linked thread after its work, once, and leaves other threads alone", () => {
    const work = (id: string, title: string) =>
      TrackerHub.portfolioFromHub(
        {
          portfolio: { projects: { [id]: { id, title, status: "active" } } },
          attention: {},
          observations: {},
        },
        context,
      ).works[0]!;
    const titles = TrackerHub.linkedWorkTitles({
      works: [work("a", "T3 chats linked to trackers"), work("b", "Second"), work("blank", " ")],
      links: [
        { workId: "a", threadId: "t1" },
        // A thread linked twice keeps the first work, so the sync cannot alternate.
        { workId: "b", threadId: "t1" },
        { workId: "b", threadId: "t2" },
        // Finished work is not in the portfolio, so its thread keeps its own title.
        { workId: "finished", threadId: "t3" },
        { workId: "blank", threadId: "t4" },
      ],
    });

    assert.deepStrictEqual(
      [...titles],
      [
        ["t1", "T3 chats linked to trackers"],
        ["t2", "Second"],
      ],
    );
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
    // Tracker K6: a stored kind is history; T3 neither carries nor shows it.
    assert.ok(work !== null && !("kind" in work), "a hub record's kind is not carried");
    assert.strictEqual(work?.briefs[0]?.date, "2026-11-14");
    assert.strictEqual(work?.needsReview, null);
    assert.deepStrictEqual(work?.docs, []);
    assert.strictEqual(work?.tagline, "");
    assert.strictEqual(
      TrackerHub.workFromHub({ project: "p", tagline: "Tracker inside T3" }, context)?.tagline,
      "Tracker inside T3",
    );
  });

  it("carries the release trains the work waits for, and not finished results (tracker K8)", () => {
    // Shape of the hub's project view `ready` (tracker 16bc6e4).
    const entry = (repo: string, state: string, waiting: number) => ({
      repo,
      branch: "feat",
      head: "1".repeat(40),
      check: `curl -fs ${repo}`,
      hosts: [],
      requires: null,
      owner: null,
      at: "2026-11-24T12:00:00-07:00",
      result: { state, reason: null, at: "2026-11-24T12:00:00-07:00" },
      waiting,
    });
    const work = TrackerHub.workFromHub(
      { project: "p", ready: [entry("harness", "merged", 0), entry("nixos", "ready", 3)] },
      context,
    );
    assert.deepStrictEqual(work?.trains, [{ repo: "nixos", check: "curl -fs nixos", waiting: 3 }]);
    assert.deepStrictEqual(TrackerHub.workFromHub({ project: "p" }, context)?.trains, []);
  });

  it("lists the record's documents and drops entries without a path", () => {
    const work = TrackerHub.workFromHub(
      {
        project: "p",
        docs: [
          { label: "Living Plan", path: "plan.md" },
          { path: "lane-map.html" },
          { label: "No path" },
          "stray",
        ],
      },
      context,
    );

    assert.deepStrictEqual(work?.docs, [
      { label: "Living Plan", path: "plan.md" },
      { label: "lane-map.html", path: "lane-map.html" },
    ]);
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
      // Eric's Link button moves ownership; the expectedThreadId check guards a stale view.
      assert.deepStrictEqual(hub.sent[1]?.body, {
        host: "hwc-laptop",
        id: "thread-2",
        title: "New",
        move: true,
      });
    }).pipe(Effect.provide(hub.layer));
  });

  it.effect("names the owner when the hub refuses a link as owned by another thread", () => {
    const refusedWith = (body: unknown) => {
      let reads = 0;
      return hubWith({
        // The first read passes the expected-link check; the hub then names a new owner.
        "GET /api/projects/t3-tracker": () => {
          reads += 1;
          return Response.json(
            project(reads === 1 ? null : { host: "hwc-work", threadId: "other", title: "CRM" }),
          );
        },
        "POST /api/projects/t3-tracker/thread": () => Response.json(body, { status: 409 }),
      });
    };
    const link = Effect.gen(function* () {
      const tracker = yield* TrackerHub.TrackerHub;
      return yield* Effect.flip(
        tracker.linkThread({
          workId: "t3-tracker",
          threadId: "thread-2" as never,
          title: "New",
          expectedThreadId: null,
        }),
      );
    });
    return Effect.gen(function* () {
      // The contract's body names the owner itself.
      const named = refusedWith({
        error: { code: "owned-by", detail: { threadId: "owner-1", title: "Website leads" } },
      });
      const fromBody = yield* link.pipe(Effect.provide(named.layer));
      assert.strictEqual(fromBody.reason, "linkChanged");
      assert.include(fromBody.detail, "This record belongs to Website leads.");

      // A legacy `{"error": "owned-by"}` names no one, so the record says who owns it.
      const bare = refusedWith({ error: "owned-by" });
      const fromRecord = yield* link.pipe(Effect.provide(bare.layer));
      assert.strictEqual(fromRecord.reason, "linkChanged");
      assert.include(fromRecord.detail, "This record belongs to CRM.");
    });
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

  it("reads a card's detail and the delivery of Done deciding", () => {
    const work = TrackerHub.workFromHub(
      {
        ...project(null),
        cards: [
          {
            id: "c1",
            kind: "decision",
            title: "Ship it",
            ask: "Release now?",
            status: "approved",
            context: "Why",
            plan: "Then",
            risk: "Low",
            recommend: "Yes",
            decidedAt: "2026-11-18T10:00",
            comments: [{ at: "2026-11-18T10:00", text: "go" }],
          },
          { id: "c2", kind: "question", title: "Bulk", ask: "Each", status: "open", bulk: {} },
        ],
        handoff: { waiting: true, at: "2026-11-18T10:01", delivery: { state: "pending" } },
      },
      context,
    );

    assert.deepStrictEqual(work?.cards[0]?.comments, [{ at: "2026-11-18T10:00", text: "go" }]);
    assert.strictEqual(work?.cards[0]?.answerable, true);
    assert.strictEqual(work?.cards[1]?.answerable, false);
    assert.deepStrictEqual(work?.handoff, {
      waiting: true,
      at: "2026-11-18T10:01",
      delivery: "pending",
      reason: null,
    });
    const read = (delivery: unknown) =>
      TrackerHub.workFromHub({ project: "p", handoff: { waiting: true, delivery } }, context)
        ?.handoff.delivery;
    assert.strictEqual(read({ ok: true }), "sent");
    assert.strictEqual(read({ ok: false, reason: "no relay" }), "failed");
    assert.strictEqual(read(null), null);
  });

  it("carries the record's watches, with a snooze only while it holds", () => {
    // Shape of the hub's project view `watches` (tracker cd20697).
    const watch = (id: string, extra: Record<string, unknown>) => ({
      id,
      kind: "pr-merged",
      repo: "Acme/widgets",
      number: 7,
      note: "then test",
      host: "hwc-work",
      at: "2026-11-24T12:00:00-07:00",
      snoozedUntil: "2026-11-25T12:00:00-07:00",
      snoozed: false,
      delivery: null,
      ...extra,
    });
    const work = TrackerHub.workFromHub(
      {
        project: "p",
        watches: [
          watch("a", {}),
          watch("b", { snoozed: true }),
          watch("c", { delivery: "failed" }),
        ],
      },
      context,
    );
    assert.deepStrictEqual(
      work?.watches.map((entry) => [entry.id, entry.snoozedUntil, entry.delivery]),
      [
        // A snooze that has run out is not shown as one.
        ["a", null, null],
        ["b", "2026-11-25T12:00:00-07:00", null],
        ["c", null, "failed"],
      ],
    );
    assert.deepStrictEqual(TrackerHub.workFromHub({ project: "p" }, context)?.watches, []);
  });

  it.effect("snoozes and cancels a watch through the hub's watch routes", () => {
    const hub = hubWith({
      "GET /api/projects/t3-tracker": () => Response.json(project(null)),
      "POST /api/v1/watches/t3-tracker/snooze": () => Response.json({ schemaVersion: 1 }),
      "DELETE /api/v1/watches/t3-tracker": () => Response.json({ schemaVersion: 1 }),
    });
    return Effect.gen(function* () {
      const tracker = yield* TrackerHub.TrackerHub;
      yield* tracker.updateWatch({ workId: "t3-tracker", watch: "w1", action: "snooze-week" });
      yield* tracker.updateWatch({ workId: "t3-tracker", watch: "w1", action: "resume" });
      yield* tracker.updateWatch({ workId: "t3-tracker", watch: "w1", action: "cancel" });
      const writes = hub.sent.filter((request) => request.method !== "GET");
      assert.deepStrictEqual(
        writes.map((request) => [request.method, request.url, request.body]),
        [
          [
            "POST",
            "/api/v1/watches/t3-tracker/snooze",
            { schemaVersion: 1, watch: "w1", hours: 168 },
          ],
          [
            "POST",
            "/api/v1/watches/t3-tracker/snooze",
            { schemaVersion: 1, watch: "w1", hours: 0 },
          ],
          ["DELETE", "/api/v1/watches/t3-tracker", { schemaVersion: 1, watch: "w1" }],
        ],
      );
    }).pipe(Effect.provide(hub.layer));
  });

  const seenLayout = { id: "1", status: "open", title: "Layout", ask: "Choose", comments: 0 };

  it.effect("answers a card on the hub's current revision", () => {
    const hub = hubWith({
      "GET /api/v1/projects/t3-tracker": () => Response.json({ revision: "rev-1" }),
      "GET /api/projects/t3-tracker": () => Response.json(project(null)),
      "POST /api/v1/projects/t3-tracker/cards/1/answer": () => Response.json({ schemaVersion: 1 }),
    });
    return Effect.gen(function* () {
      const tracker = yield* TrackerHub.TrackerHub;
      yield* tracker.answerCard({
        workId: "t3-tracker",
        card: seenLayout,
        status: "approved",
        comment: "Use the sidebar",
      });

      const write = hub.sent.find((request) => request.method === "POST");
      assert.strictEqual(write?.url, "/api/v1/projects/t3-tracker/cards/1/answer");
      assert.deepStrictEqual(write?.body, {
        schemaVersion: 1,
        expectedRevision: "rev-1",
        status: "approved",
        comment: "Use the sidebar",
      });
    }).pipe(Effect.provide(hub.layer));
  });

  it.effect("refuses an answer to a card that changed after Eric read it", () => {
    const hub = hubWith({
      "GET /api/v1/projects/t3-tracker": () => Response.json({ revision: "rev-1" }),
      "GET /api/projects/t3-tracker": () => Response.json(project(null)),
    });
    return Effect.gen(function* () {
      const tracker = yield* TrackerHub.TrackerHub;
      const error = yield* Effect.flip(
        tracker.answerCard({
          workId: "t3-tracker",
          card: { ...seenLayout, ask: "Choose one" },
          status: "approved",
          comment: "",
        }),
      );

      assert.strictEqual(error.reason, "cardChanged");
      assert.isFalse(hub.sent.some((request) => request.method === "POST"));
    }).pipe(Effect.provide(hub.layer));
  });

  it.effect("retries once on a moved revision, then reports the hub's own reason", () => {
    let answers = 0;
    const hub = hubWith({
      "GET /api/v1/projects/t3-tracker": () => Response.json({ revision: `rev-${answers}` }),
      "GET /api/projects/t3-tracker": () => Response.json(project(null)),
      "POST /api/v1/projects/t3-tracker/cards/1/answer": () => {
        answers += 1;
        return answers === 1
          ? Response.json({ error: { code: "stale-revision" } }, { status: 409 })
          : Response.json(
              { error: { code: "question-needs-answer", detail: "a question needs an answer" } },
              { status: 400 },
            );
      },
    });
    return Effect.gen(function* () {
      const tracker = yield* TrackerHub.TrackerHub;
      const error = yield* Effect.flip(
        tracker.answerCard({ workId: "t3-tracker", card: seenLayout, status: null, comment: "" }),
      );

      const writes = hub.sent.filter((request) => request.method === "POST");
      assert.deepStrictEqual(
        writes.map((request) => (request.body as { expectedRevision: string }).expectedRevision),
        ["rev-0", "rev-1"],
      );
      assert.strictEqual(error.reason, "refused");
      assert.include(error.detail, "a question needs an answer");
    }).pipe(Effect.provide(hub.layer));
  });

  it.effect("refuses Done deciding while a card Eric never saw is waiting", () => {
    const hub = hubWith({
      "GET /api/v1/projects/t3-tracker": () => Response.json({ revision: "rev-1" }),
      "GET /api/projects/t3-tracker": () => Response.json(project(null)),
      "POST /api/v1/projects/t3-tracker/handoff": () => Response.json({ schemaVersion: 1 }),
    });
    return Effect.gen(function* () {
      const tracker = yield* TrackerHub.TrackerHub;
      const error = yield* Effect.flip(
        tracker.doneDeciding({ workId: "t3-tracker", cards: [seenLayout] }),
      );
      assert.strictEqual(error.reason, "cardChanged");

      yield* tracker.doneDeciding({
        workId: "t3-tracker",
        cards: [seenLayout, { id: "2", status: "done", title: "Old", ask: "Chosen", comments: 0 }],
      });
      const writes = hub.sent.filter((request) => request.method === "POST");
      assert.deepStrictEqual(
        writes.map((request) => request.body),
        [{ schemaVersion: 1, expectedRevision: "rev-1" }],
      );
    }).pipe(Effect.provide(hub.layer));
  });

  it.effect("starts an agent on this host and waits for the relay to name its thread", () => {
    let posts = 0;
    const hub = hubWith({
      "POST /api/projects/t3-tracker/start": () => {
        posts += 1;
        return Response.json({
          key: "press-1",
          delivery:
            posts === 1
              ? { id: "d1", state: "pending", host: "hwc-laptop" }
              : { id: "d1", state: "delivered", host: "hwc-laptop", threadId: "thread-new" },
        });
      },
    });
    return Effect.gen(function* () {
      const tracker = yield* TrackerHub.TrackerHub;
      const start = yield* tracker
        .startAgent({
          workId: "t3-tracker",
          key: "press-1",
          request: "Pick up P2",
          model: { instanceId: "codex" as never, model: "gpt-5.4" },
        })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");

      assert.deepStrictEqual(yield* Fiber.join(start), {
        host: "hwc-laptop",
        threadId: "thread-new",
      });
      const body = {
        schemaVersion: 1,
        app: "t3",
        host: "hwc-laptop",
        key: "press-1",
        request: "Pick up P2",
        model: { instanceId: "codex", model: "gpt-5.4" },
      };
      // The progress read repeats the same key, so the hub starts nothing new.
      assert.deepStrictEqual(
        hub.sent.map((sent) => sent.body),
        [body, body],
      );
    }).pipe(Effect.provide(hub.layer));
  });

  it.effect("says in plain words why the hub refused a start", () => {
    const refusedWith = (status: number, error: unknown) =>
      hubWith({
        "POST /api/projects/t3-tracker/start": () => Response.json({ error }, { status }),
      }).layer;
    const start = Effect.gen(function* () {
      const tracker = yield* TrackerHub.TrackerHub;
      return yield* Effect.flip(tracker.startAgent({ workId: "t3-tracker", key: "k" }));
    });
    return Effect.gen(function* () {
      for (const [status, code, words] of [
        [409, "agent-start-pending", "Another agent is already starting"],
        [409, "agent-start-unavailable", "No tracker relay on hwc-laptop can start agents"],
        [409, "agent-model-unavailable", "too old to take a model choice"],
        [400, "bad-start", "refused the start as malformed"],
      ] as const) {
        const error = yield* start.pipe(Effect.provide(refusedWith(status, code)));
        assert.strictEqual(error.reason, "refused");
        assert.include(error.detail, words);
      }
      const missing = yield* start.pipe(Effect.provide(hubWith({}).layer));
      assert.strictEqual(missing.reason, "notFound");
      const failed = yield* start.pipe(
        Effect.provide(
          hubWith({
            "POST /api/projects/t3-tracker/start": () =>
              Response.json({ delivery: { state: "failed", reason: "no workspace" } }),
          }).layer,
        ),
      );
      assert.include(failed.detail, "The agent did not start: no workspace.");
    });
  });

  it.effect("names the live record a thread owns, and fails rather than guess", () => {
    const portfolio = {
      projects: {
        done: { id: "done", status: "complete", thread: { host: "hwc-laptop", threadId: "t1" } },
        live: { id: "live", status: "active", thread: { host: "hwc-laptop", threadId: "t1" } },
        away: { id: "away", status: "active", thread: { host: "hwc-work", threadId: "t2" } },
      },
    };
    const owner = (threadId: string) =>
      Effect.gen(function* () {
        const tracker = yield* TrackerHub.TrackerHub;
        return yield* tracker.threadOwner({ threadId: threadId as never });
      });
    const reachable = hubWith({ "GET /api/portfolio": () => Response.json(portfolio) }).layer;
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* owner("t1").pipe(Effect.provide(reachable)), {
        workId: "live",
      });
      // A thread on another host is not this server's thread.
      assert.deepStrictEqual(yield* owner("t2").pipe(Effect.provide(reachable)), {
        workId: null,
      });
      const down = hubWith({ "GET /api/portfolio": () => null }).layer;
      const error = yield* owner("t1").pipe(Effect.flip, Effect.provide(down));
      assert.strictEqual(error.reason, "unreachable");
    });
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
