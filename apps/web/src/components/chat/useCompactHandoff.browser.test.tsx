import { EnvironmentId, MessageId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { useCompactHandoff } from "./useCompactHandoff";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ readonly label: string; readonly target: unknown }>,
}));
vi.mock(import("~/state/use-atom-command"), () => ({
  useAtomCommand: ((command: { readonly label: string }) => async (target: unknown) => {
    state.calls.push({ label: command.label, target });
    return { _tag: "Success", value: { sequence: 1 } };
  }) as never,
}));
vi.mock(import("../tracker/useTrackerAgentStart"), () => ({
  useTrackerAgentStart: (() => async () => true) as never,
}));

const environmentId = EnvironmentId.make("environment");
const fixture = makeThreadProjectionFixture();
const sentAt = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const projection = {
  ...fixture,
  messages: [
    {
      id: MessageId.make("message-1"),
      threadId: fixture.thread.id,
      runId: null,
      nodeId: null,
      role: "user" as const,
      text: "A long piece of work",
      attachments: [],
      streaming: false,
      createdAt: sentAt,
      updatedAt: sentAt,
      createdBy: "user" as const,
      creationSource: "web" as const,
    },
  ],
};

function Banner() {
  const item = useCompactHandoff({
    environmentId,
    projection,
    snapshotCurrent: true,
    // Idle overnight on an expensive context: the old client prepared a handoff here.
    nowMinute: "2026-01-01T09:00",
    usedTokens: 150_000,
  });
  return item === null ? null : (
    <div>
      <p>{item.title}</p>
      {item.actions}
    </div>
  );
}

it("prepares nothing on an idle thread and starts fresh as an empty thread on the same model", async () => {
  state.calls = [];
  await using screen = await render(<Banner />);

  await userEvent.click(screen.getByRole("button", { name: "Start fresh" }));
  await vi.waitFor(() => expect(state.calls).toHaveLength(1));

  expect(state.calls.some((call) => call.label.includes("handoff"))).toBe(false);
  const create = state.calls[0]!;
  expect(create.label).toBe("environment-data:commands:thread:create");
  const { input } = create.target as {
    readonly input: { readonly threadId: string } & Record<string, unknown>;
  };
  expect(input).toEqual({
    threadId: input.threadId,
    projectId: fixture.thread.projectId,
    title: "New thread",
    modelSelection: fixture.thread.modelSelection,
    runtimeMode: fixture.thread.runtimeMode,
    interactionMode: fixture.thread.interactionMode,
    branch: null,
    worktreePath: null,
    creationSource: "web",
  });
  expect(input.threadId).not.toBe(fixture.thread.id);
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe(`/environment/${input.threadId}`),
  );
});
