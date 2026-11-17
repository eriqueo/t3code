import type { TrackerPortfolio, TrackerWorkSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  currentPhase,
  domainSections,
  linkedWorkIdForThread,
  progressFraction,
  resumableThreadId,
  trackerActionMessage,
  trackerActions,
  workStatus,
} from "./tracker.logic";

const work = (id: string, patch: Partial<TrackerWorkSummary> = {}): TrackerWorkSummary => ({
  id,
  title: id,
  goal: "",
  domain: "hwc",
  kind: "project",
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
  });

  it("offers roadmap and handoff only to projects, and confirms only Close Out", () => {
    expect(trackerActions({ kind: "project" }).map((action) => action.id)).toEqual([
      "next-step",
      "update-roadmap",
      "handoff",
      "grill",
      "close-out",
    ]);
    expect(trackerActions({ kind: "task" }).map((action) => action.id)).toEqual([
      "next-step",
      "grill",
      "close-out",
    ]);
    expect(trackerActions({ kind: null }).some((action) => action.id === "handoff")).toBe(false);
    expect(
      trackerActions({ kind: "project" })
        .filter((action) => action.confirm)
        .map((action) => action.id),
    ).toEqual(["close-out"]);
  });

  it("names the skill, the action, the record and the thread in each message", () => {
    expect(trackerActionMessage("update-roadmap", "t3-tracker", "thread-1")).toBe(
      "Use project-tracker: sidebar action `update-roadmap` on record `t3-tracker` from thread `thread-1`.",
    );
  });
});
