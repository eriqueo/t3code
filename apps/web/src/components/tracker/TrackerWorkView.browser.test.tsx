import { EnvironmentId, type TrackerWorkDetail } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { TrackerWorkView } from "./TrackerWorkView";

vi.mock("~/hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("~/state/entities", () => ({
  useProjects: () => [{ id: "project-1", environmentId: "local", title: "My Project" }],
  useThreadShell: () => null,
}));
const command = vi.hoisted(() => vi.fn(async () => ({ _tag: "Success", value: null })));
vi.mock("~/state/server", () => ({
  serverEnvironment: {
    trackerLaunchPrompt: {},
    trackerAnswerCard: { permissionAtom: () => null },
    trackerDoneDeciding: {},
  },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => command }));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => true,
}));
vi.mock("~/state/tracker", () => ({ errorText: String }));

const baseWork: TrackerWorkDetail = {
  host: "hwc-laptop",
  hubUrl: "https://hub.test",
  fetchedAt: "",
  id: "work-1",
  title: "Work",
  goal: "",
  tagline: "",
  domain: null,
  status: "active",
  updated: null,
  lastWork: null,
  waitingOnYou: false,
  progress: { done: 0, total: 0 },
  phases: [],
  cards: [],
  briefs: [],
  docs: [],
  needsReview: null,
  thread: null,
  handoff: { waiting: false, at: null, delivery: null, reason: null },
};

it("opens the tracker draft menu with its labelled project group", async () => {
  const work = baseWork;
  await using screen = await render(
    <TrackerWorkView
      environmentId={EnvironmentId.make("local")}
      work={work}
      density="page"
      domainColour={null}
      domainLabel={null}
    />,
  );
  // Tracker K6: the header names no task or project kind.
  await expect.element(page.getByText(/^(task|project)$/i)).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Launch Agent" }).click();
  await expect.element(page.getByRole("group", { name: "Start a draft in" })).toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: "My Project" })).toBeVisible();
});

it("answers a decision in T3, naming the card as Eric read it", async () => {
  command.mockClear();
  const work: TrackerWorkDetail = {
    ...baseWork,
    thread: { host: "hwc-laptop", threadId: "t1", title: "Chat", linkedAt: null },
    cards: [
      {
        id: "c1",
        kind: "decision",
        title: "Ship the sidebar",
        ask: "Release it today?",
        status: "open",
        phase: "P3",
        context: "Built and checked.",
        plan: "It goes to every machine.",
        risk: "",
        recommend: "Approve",
        decidedAt: null,
        comments: [],
        answerable: true,
      },
    ],
  };
  await using screen = await render(
    <TrackerWorkView
      environmentId={EnvironmentId.make("local")}
      work={work}
      density="page"
      domainColour={null}
      domainLabel={null}
    />,
  );
  await screen.getByRole("textbox", { name: "Comment on Ship the sidebar" }).fill("Go ahead");
  await screen.getByRole("button", { name: "Approve" }).click();

  expect(command).toHaveBeenCalledWith({
    environmentId: "local",
    input: {
      workId: "work-1",
      card: {
        id: "c1",
        status: "open",
        title: "Ship the sidebar",
        ask: "Release it today?",
        comments: 0,
      },
      status: "approved",
      comment: "Go ahead",
    },
  });
});
