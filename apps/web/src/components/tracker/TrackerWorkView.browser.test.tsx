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
vi.mock("~/state/server", () => ({ serverEnvironment: { trackerLaunchPrompt: {} } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/tracker", () => ({ errorText: String }));

it("opens the tracker draft menu with its labelled project group", async () => {
  const work: TrackerWorkDetail = {
    host: "hwc-laptop",
    hubUrl: "https://hub.test",
    fetchedAt: "",
    id: "work-1",
    title: "Work",
    goal: "",
    tagline: "",
    domain: null,
    kind: "task",
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
  await screen.getByRole("button", { name: "Launch Agent" }).click();
  await expect.element(page.getByRole("group", { name: "Start a draft in" })).toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: "My Project" })).toBeVisible();
});
