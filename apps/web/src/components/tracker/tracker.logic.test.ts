import type { TrackerPortfolio, TrackerWorkSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  cardStatusLabel,
  currentPhase,
  decisionCards,
  doneDecidingText,
  domainSections,
  linkedWorkIdForThread,
  progressFraction,
  resumableThreadId,
  trackerActionMessage,
  trackerActionRefusal,
  trackerActions,
  trackerDocUrl,
  trackerCardSeen,
  trackerSummary,
  trackerWhen,
  workMatchesQuery,
  workStatus,
  watchStateLabel,
} from "./tracker.logic";

const work = (id: string, patch: Partial<TrackerWorkSummary> = {}): TrackerWorkSummary => ({
  id,
  title: id,
  goal: "",
  domain: "hwc",
  status: "active",
  state: "ok",
  openCards: 0,
  waitingOnYou: false,
  overdue: false,
  lastWork: null,
  progress: { done: 0, total: 0 },
  ...patch,
});

const portfolio = (patch: Partial<TrackerPortfolio>): TrackerPortfolio => ({
  host: "hwc-laptop",
  hubUrl: "http://hub.test",
  fetchedAt: "2026-11-16T00:00:00.000Z",
  today: "2026-11-16",
  liveCap: 20,
  liveProjects: 0,
  domains: [],
  works: [],
  attention: [],
  links: [],
  threads: [],
  ...patch,
});

const thread = (host: string, threadId: string) => ({ host, threadId, title: "", linkedAt: null });

describe("tracker logic", () => {
  it("finds the work a conversation is linked to, and nothing for a stranger", () => {
    const links = { links: [{ workId: "a", threadId: "t1" }] };

    expect(linkedWorkIdForThread(links, "t1")).toBe("a");
    expect(linkedWorkIdForThread(links, "t2")).toBeNull();
    expect(linkedWorkIdForThread(null, "t1")).toBeNull();
  });

  it("reopens only a T3 thread on this host", () => {
    expect(resumableThreadId({ host: "hwc-laptop", thread: thread("hwc-laptop", "t1") })).toBe(
      "t1",
    );
    expect(resumableThreadId({ host: "hwc-laptop", thread: thread("hwc-work", "t1") })).toBeNull();
    expect(
      resumableThreadId({ host: "hwc-laptop", thread: thread("hwc-laptop", "herdr:t2") }),
    ).toBeNull();
    expect(resumableThreadId({ host: "hwc-laptop", thread: null })).toBeNull();
  });

  it("keeps work the hub files under no domain visible", () => {
    const sections = domainSections(
      portfolio({
        domains: [
          { id: "hwc", label: "HWC", colour: null, count: 1, needYou: 0, workIds: ["a", "gone"] },
          { id: "empty", label: "Empty", colour: null, count: 0, needYou: 0, workIds: [] },
        ],
        works: [work("a", { waitingOnYou: true }), work("parked", { status: "parked" })],
      }),
      null,
    );

    expect(sections.map((section) => [section.id, section.works.map((item) => item.id)])).toEqual([
      ["hwc", ["a"]],
      ["unfiled", ["parked"]],
    ]);
    expect(sections[0]?.needYou).toBe(1);
  });

  it("narrows to one domain", () => {
    const sections = domainSections(
      portfolio({
        domains: [
          { id: "hwc", label: "HWC", colour: null, count: 1, needYou: 0, workIds: ["a"] },
          { id: "infra", label: "Infra", colour: null, count: 1, needYou: 0, workIds: ["b"] },
        ],
        works: [work("a"), work("b")],
      }),
      "infra",
    );

    expect(sections.map((section) => section.id)).toEqual(["infra"]);
  });

  it("shows no percentage for work without phases", () => {
    expect(progressFraction({ done: 0, total: 0 })).toBeNull();
    expect(progressFraction({ done: 1, total: 4 })).toBe(0.25);
  });

  it("puts a decision owed ahead of every other status", () => {
    expect(workStatus(work("a", { waitingOnYou: true, overdue: true })).label).toBe(
      "Waiting on you",
    );
    expect(workStatus(work("a", { overdue: true })).label).toBe("Overdue");
    expect(workStatus(work("a", { status: "parked" })).label).toBe("Parked");
    expect(workStatus(work("a")).label).toBe("On track");
  });

  it("names the first phase that is not done", () => {
    const phase = (id: string, status: string) => ({
      id,
      title: id,
      status,
      planned: null,
      done: null,
      terminal: false,
      wait: null,
    });

    expect(
      currentPhase([phase("P1", "done"), phase("P2", "waiting"), phase("P3", "next")])?.id,
    ).toBe("P2");
    expect(
      currentPhase([phase("P1", "done"), phase("P2", "next"), phase("P3", "active")])?.id,
    ).toBe("P3");
    expect(currentPhase([phase("P1", "done")])).toBeNull();
    expect(currentPhase([phase("P1", "dropped"), phase("P2", "next")])?.id).toBe("P2");
    expect(currentPhase([phase("P1", "done"), phase("P2", "dropped")])).toBeNull();
  });

  it("offers roadmap and handoff only to records with phases, and confirms only Close Out", () => {
    const phased = {
      status: "active",
      closeRefusal: null,
      phases: [
        {
          id: "P1",
          title: "Ship",
          status: "next",
          planned: null,
          done: null,
          terminal: true,
          wait: null,
        },
      ],
    };
    expect(trackerActions(phased).map((action) => action.id)).toEqual([
      "next-step",
      "tidy",
      "handoff",
      "grill",
      "prove-it",
      "status",
      "wait-what",
      "close-out",
    ]);
    const task = { phases: [], status: "active", closeRefusal: null };
    expect(trackerActions(task).map((action) => action.id)).toEqual([
      "next-step",
      "grill",
      "prove-it",
      "status",
      "wait-what",
      "close-out",
    ]);
    expect(
      trackerActions(phased)
        .filter((action) => action.confirm)
        .map((action) => action.id),
    ).toEqual(["close-out"]);
  });

  // standing-work-items, 2026-11-27: Close Out reached datax-v3-map, a record whose close
  // would have stopped its weekly refresh. A standing or closed record offers none.
  it("offers Close Out only on a record the hub says can close now", () => {
    const standing = {
      phases: [],
      status: "active",
      closeRefusal: "datax-v3-map is standing, so it cannot be closed: the weekly refresh runs.",
    };
    expect(trackerActions(standing).map((action) => action.id)).not.toContain("close-out");
    expect(trackerActions(standing).map((action) => action.id)).toContain("next-step");
    for (const status of ["complete", "archived", "superseded", "dropped"]) {
      const closed = { phases: [], status, closeRefusal: null };
      expect(trackerActions(closed).map((action) => action.id)).not.toContain("close-out");
    }
  });

  it("sends actions only from the conversation that owns the record", () => {
    const owner = { host: "hwc-work", threadId: "thread-1", title: "CRM", linkedAt: null };
    expect(trackerActionRefusal({ thread: owner }, "thread-1")).toBeNull();
    // Released (settled) or never linked: the record has no conversation.
    expect(trackerActionRefusal({ thread: null }, "thread-1")).toBe(
      "This record has no conversation. Link this one first.",
    );
    expect(trackerActionRefusal({ thread: owner }, "thread-2")).toBe(
      "This record belongs to CRM. Open that conversation or move the link here.",
    );
    expect(trackerActionRefusal({ thread: { ...owner, title: "" } }, "thread-2")).toBe(
      "This record belongs to thread-1. Open that conversation or move the link here.",
    );
  });

  it("opens a document in the hub's own viewer, escaping the record and path", () => {
    expect(trackerDocUrl("http://hub.test", "t3-tracker", "plan.md")).toBe(
      "http://hub.test/p/t3-tracker/docs?doc=plan.md",
    );
    expect(trackerDocUrl("http://hub.test", "a b", "notes/run 1.md")).toBe(
      "http://hub.test/p/a%20b/docs?doc=notes%2Frun%201.md",
    );
  });

  it("summarises in one line from the tagline, falling back to the goal", () => {
    expect(trackerSummary({ tagline: "Tracker inside T3", goal: "A long goal." })).toBe(
      "Tracker inside T3",
    );
    expect(trackerSummary({ tagline: "  ", goal: " A long goal. " })).toBe("A long goal.");
    expect(trackerSummary({ tagline: "", goal: "" })).toBe("");
  });

  const card = (id: string, status: string) => ({
    id,
    kind: "decision",
    title: id,
    ask: "Ask",
    status,
    phase: "",
    context: "",
    plan: "",
    risk: "",
    recommend: "",
    decidedAt: null,
    comments: [{ at: null, text: "x" }],
    answerable: true,
  });

  it("splits cards into waiting and answered, leaving finished ones out", () => {
    const { open, decided } = decisionCards([
      card("a", "open"),
      card("b", "approved"),
      card("c", "answered"),
      card("d", "done"),
      card("e", "expired"),
    ]);

    expect(open.map((entry) => entry.id)).toEqual(["a"]);
    expect(decided.map((entry) => entry.id)).toEqual(["b", "c"]);
    expect(cardStatusLabel(card("a", "open"))).toBe("Waiting on you");
    expect(trackerCardSeen(card("b", "approved"))).toEqual({
      id: "b",
      status: "approved",
      title: "b",
      ask: "Ask",
      comments: 1,
    });
  });

  it("words Done deciding by where the answers are", () => {
    const thread = { host: "hwc-laptop", threadId: "t1", title: "Chat", linkedAt: null };
    const handoff = { waiting: false, at: null, delivery: null, reason: null } as const;

    expect(doneDecidingText({ thread, handoff })).toBe(
      "Send your saved answers to Chat on hwc-laptop.",
    );
    expect(doneDecidingText({ thread: null, handoff })).toContain("the hub starts one");
    expect(
      doneDecidingText({
        thread,
        handoff: { waiting: true, at: "2026-11-18T10:01", delivery: "pending", reason: null },
      }),
    ).toBe("Recorded 2026-11-18 10:01; waiting for hwc-laptop to post it.");
    expect(
      doneDecidingText({
        thread,
        handoff: { waiting: true, at: null, delivery: "failed", reason: "no relay" },
      }),
    ).toBe("Saved, but not sent: no relay.");
    expect(trackerWhen("2026-11-18T10:01:33-07:00")).toBe("2026-11-18 10:01");
  });

  it("says where a watch stands: fired first, then snoozed, else watching", () => {
    const at = (iso: string) => `at ${iso}`;
    const watching = { snoozedUntil: null, delivery: null };
    expect(watchStateLabel(watching, at)).toBe("Watching · checked every 15 minutes");
    expect(watchStateLabel({ ...watching, snoozedUntil: "2026-11-25T12:00" }, at)).toBe(
      "Snoozed until at 2026-11-25T12:00",
    );
    expect(watchStateLabel({ snoozedUntil: "2026-11-25T12:00", delivery: "failed" }, at)).toBe(
      "Fired · the wake failed, retrying",
    );
    expect(watchStateLabel({ ...watching, delivery: "pending" }, at)).toBe(
      "Fired · waking the agent",
    );
  });

  it("finds work by its title or by the words of its id", () => {
    const record = work("work-memory-ownership", { title: "Single-owner work facts in tracker" });
    expect(workMatchesQuery(record, "")).toBe(true);
    expect(workMatchesQuery(record, "Single-owner")).toBe(true);
    expect(workMatchesQuery(record, "work-memory")).toBe(true);
    expect(workMatchesQuery(record, "work memory")).toBe(true);
    expect(workMatchesQuery(record, "  Memory_Ownership ")).toBe(true);
    expect(workMatchesQuery(record, "memory tracker")).toBe(false);
  });

  it("names the skill, the action, the record and the thread in each message", () => {
    expect(trackerActionMessage("next-step", "t3-tracker", "thread-1")).toBe(
      "Use project-tracker: sidebar action `next-step` on record `t3-tracker` from thread `thread-1`.",
    );
    expect(trackerActionMessage("tidy", "t3-tracker", "thread-1")).toBe(
      "Use project-tracker: sidebar action `tidy` on record `t3-tracker` from thread `thread-1`.",
    );
    // Status and Wait, What? ask for an explanation and no work, so they name no skill.
    const status = trackerActionMessage("status", "t3-tracker", "thread-1");
    expect(status).toContain("record `t3-tracker`");
    expect(status).toContain("Do no new work and change nothing.");
    expect(status).not.toContain("project-tracker");
    const again = trackerActionMessage("wait-what", "t3-tracker", "thread-1");
    expect(again).toContain("that last message did not land");
    expect(again).toContain("Do no new work.");
    expect(again).not.toContain("project-tracker");
    expect(trackerActionMessage("prove-it", "t3-tracker", "thread-1")).toBe(
      "Use prove-it on your latest substantive result in this conversation: the last plan, diagnosis, findings, report or code change you gave, not a status note or your reply to this message. Name that target in one sentence, then start the review. If a newer message from Eric changed the subject, say which result you would review and ask first (record `t3-tracker`, thread `thread-1`).",
    );
  });
});
