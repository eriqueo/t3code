import { MessageId, type OrchestrationMessage } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import { buildContextHandoffPrompt, prepareContextHandoff } from "./contextHandoffWorker.ts";

const message = (id: string, role: "user" | "assistant", text: string): OrchestrationMessage => ({
  id: MessageId.make(id),
  role,
  text,
  turnId: null,
  streaming: false,
  createdAt: "2026-09-12T00:00:00.000Z",
  updatedAt: "2026-09-12T00:00:00.000Z",
});

it.effect("runs the read-only DX2 adapter with a bounded contract", () =>
  Effect.gen(function* () {
    let invocation: ProcessRunner.ProcessRunInput | undefined;
    const result = yield* prepareContextHandoff({
      cwd: "/workspace",
      title: "Long task",
      messages: [message("one", "user", "Build it"), message("two", "assistant", "Working")],
    }).pipe(
      Effect.provideService(
        ProcessRunner.ProcessRunner,
        ProcessRunner.ProcessRunner.of({
          run: (input) => {
            invocation = input;
            return Effect.succeed({
              stdout: JSON.stringify({
                schemaVersion: 1,
                provider: "pi",
                requestedModel: "dx2/llm",
                state: "completed",
                result: "# Operational handoff\n\n## Objective\n\nBuild it.",
                elapsedMs: 84,
              }),
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            });
          },
        }),
      ),
    );
    assert.strictEqual(invocation?.command, "t3-dx2-handoff");
    assert.deepEqual(invocation?.args, ["--max-result-characters", "16384"]);
    assert.strictEqual(invocation?.cwd, "/workspace");
    assert.match(invocation?.stdin ?? "", /## Settled decisions/);
    assert.strictEqual(result.outputCharacters, result.handoff.length);
  }),
);

it("caps conversation material before invoking the worker", () => {
  const prompt = buildContextHandoffPrompt({
    title: "Bounded",
    messages: [
      message("huge", "user", "x".repeat(100_000)),
      message("latest", "assistant", "latest"),
    ],
  });
  assert.isBelow(prompt.length, 70_000);
  assert.notInclude(prompt, "x".repeat(1_000));
  assert.include(prompt, "latest");
});
