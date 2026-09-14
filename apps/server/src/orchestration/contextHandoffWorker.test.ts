import { MessageId, type OrchestrationMessage } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import {
  buildContextHandoffInput,
  buildContextHandoffPrompt,
  prepareContextHandoff,
  renderContextHandoff,
} from "./contextHandoffWorker.ts";

const encodeFixture = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const message = (id: string, role: "user" | "assistant", text: string): OrchestrationMessage => ({
  id: MessageId.make(id),
  role,
  text,
  turnId: null,
  streaming: false,
  createdAt: "2026-09-12T00:00:00.000Z",
  updatedAt: "2026-09-12T00:00:00.000Z",
});

const runWithWorkerText = (text: string) =>
  prepareContextHandoff({
    cwd: "/workspace",
    title: "Pending decision",
    messages: [
      message("one", "user", "Inspect only; do not deploy."),
      message("two", "assistant", "The build failed. Waiting for your decision."),
    ],
  }).pipe(
    Effect.provideService(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({
        run: () =>
          Effect.succeed({
            stdout: encodeFixture({
              schemaVersion: 1,
              provider: "pi",
              requestedModel: "dx2/llm",
              state: "completed",
              result: text,
              elapsedMs: 1,
            }),
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          }),
      }),
    ),
  );

it.effect("rejects model-authored claims rather than publishing an invented successful build", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      runWithWorkerText("# Operational handoff\nThe build passed; deploy now."),
    );
    assert.isTrue(Result.isFailure(result));
  }),
);

it.effect(
  "resolves source references and copies the latest permission and failed build verbatim",
  () =>
    Effect.gen(function* () {
      const result = yield* runWithWorkerText(
        encodeFixture({ version: 1, passageIds: ["P1", "P2"] }),
      );
      assert.include(result.handoff, "> Inspect only; do not deploy.");
      assert.include(result.handoff, "> The build failed. Waiting for your decision.");
      assert.notInclude(result.handoff, '"passageIds"');
    }),
);

it.effect("rejects references to absent source passages", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      runWithWorkerText(encodeFixture({ version: 1, passageIds: ["P999"] })),
    );
    assert.isTrue(Result.isFailure(result));
  }),
);

it.effect("accepts a single JSON code fence without accepting surrounding narrative", () =>
  Effect.gen(function* () {
    const json = encodeFixture({ version: 1, passageIds: ["P1", "P2"] });
    const result = yield* runWithWorkerText("```json\n" + json + "\n```");
    assert.include(result.handoff, "> Inspect only; do not deploy.");
    const invalid = yield* Effect.result(
      runWithWorkerText("Deploy now\n```json\n" + json + "\n```"),
    );
    assert.isTrue(Result.isFailure(invalid));
  }),
);

it("bounds the entire prompt including an oversized title", () => {
  assert.isAtMost(
    buildContextHandoffPrompt({
      title: "x".repeat(100_000),
      messages: [message("one", "user", "Inspect only")],
    }).length,
    65_536,
  );
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
              stdout: encodeFixture({
                schemaVersion: 1,
                provider: "pi",
                requestedModel: "dx2/llm",
                state: "completed",
                result: encodeFixture({ version: 1, passageIds: ["P1", "P2"] }),
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
    assert.match(invocation?.stdin ?? "", /passageIds/);
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
  assert.isAtMost(prompt.length, 65_536);
  assert.notInclude(prompt, "x".repeat(1_401));
  assert.include(prompt, "latest");
});

it.effect("retains selected evidence beyond a truncated latest-message anchor", () =>
  Effect.gen(function* () {
    const input = buildContextHandoffInput({
      title: "Long result",
      messages: [
        message("user", "user", "Inspect only"),
        message(
          "assistant",
          "assistant",
          "x".repeat(3000) + "\n\nThe final build failed; do not deploy.",
        ),
      ],
    });
    const tail = input.records.find((r) => r.text === "The final build failed; do not deploy.");
    assert.isDefined(tail);
    const handoff = yield* renderContextHandoff(
      input,
      encodeFixture({ version: 1, passageIds: [tail!.id] }),
    );
    assert.include(handoff, "> The final build failed; do not deploy.");
    assert.include(handoff, "original message is longer");
  }),
);

it.effect("rejects duplicate and oversized selections without emitting a partial report", () =>
  Effect.gen(function* () {
    const duplicate = yield* Effect.result(
      runWithWorkerText(encodeFixture({ version: 1, passageIds: ["P1", "P1"] })),
    );
    assert.isTrue(Result.isFailure(duplicate));
    const input = buildContextHandoffInput({
      title: "Bound",
      messages: [message("one", "user", "x".repeat(15000))],
    });
    const tooLarge = yield* Effect.result(
      renderContextHandoff(
        input,
        encodeFixture({ version: 1, passageIds: input.records.slice(0, 8).map((r) => r.id) }),
      ),
    );
    assert.isTrue(Result.isFailure(tooLarge));
  }),
);

it("does not split Unicode surrogate pairs when bounding source passages", () => {
  const text = "x".repeat(1399) + "😀tail";
  const input = buildContextHandoffInput({
    title: "Unicode",
    messages: [message("one", "user", text)],
  });
  assert.strictEqual(input.records.map((r) => r.text).join(""), text);
  assert.isTrue(input.records.every((r) => !/[\uD800-\uDBFF]$/.test(r.text)));
});

it.effect("rejects excessive rendered quotation cost before rendering a report", () =>
  Effect.gen(function* () {
    const input = buildContextHandoffInput({
      title: "Many short lines",
      messages: [
        message("one", "assistant", "a\nb\n".repeat(2100)),
        message("two", "user", "Continue the inspection"),
        message("three", "assistant", "Still pending"),
      ],
    });
    const result = yield* renderContextHandoff(
      input,
      encodeFixture({ version: 1, passageIds: input.records.map((r) => r.id) }),
    ).pipe(Effect.flip);
    assert.strictEqual(result.code, "selection_too_large");
  }),
);

it("keeps a contiguous recent passage window instead of backfilling older short passages", () => {
  const input = buildContextHandoffInput({
    title: "Recent window",
    messages: [
      message("old", "user", "old"),
      message("large", "assistant", "x".repeat(100_000)),
      message("last", "user", "latest"),
    ],
  });
  assert.isAbove(input.omitted, 0);
  assert.notInclude(
    input.records.map((r) => r.source),
    "old",
  );
  const ids = input.records.map((r) => Number(r.id.slice(1)));
  assert.strictEqual(ids.at(-1)! - ids[0]! + 1, ids.length);
});

it.effect("honors rendered passage weights at the selection limit with dense anchors", () =>
  Effect.gen(function* () {
    const makeInput = (lastLength: number) =>
      buildContextHandoffInput({
        title: "Rendered budget",
        messages: [
          message(
            "evidence",
            "assistant",
            [...Array.from({ length: 6 }, () => "x".repeat(1_400)), "y".repeat(lastLength)].join(
              "\n\n",
            ),
          ),
          message("user", "user", "u\n".repeat(4_000)),
          message("assistant", "assistant", "a\n".repeat(4_000)),
        ],
      });
    const initial = makeInput(1);
    const baseCost = initial.records.slice(0, 7).reduce((n, r) => n + r.characters, 0);
    const input = makeInput(9_000 - baseCost + 1);
    const selected = input.records.slice(0, 7);
    assert.strictEqual(
      selected.reduce((n, r) => n + r.characters, 0),
      9_000,
    );
    const handoff = yield* renderContextHandoff(
      input,
      encodeFixture({ version: 1, passageIds: selected.map((r) => r.id) }),
    );
    const supporting = handoff
      .split("## Supporting historical evidence (newest first)\n\n")[1]!
      .split("## Coverage and continuation")[0]!;
    assert.strictEqual(supporting.length, 9_000);
    const anchors = handoff
      .split("## Latest recorded messages\n\n")[1]!
      .split("## Supporting historical evidence")[0]!;
    assert.isAtMost(anchors.length, 4_800);
    assert.isAtMost(handoff.length, 16_384);
    assert.include(input.prompt, `${selected[0]!.characters} rendered characters`);
    const over = makeInput(9_000 - baseCost + 2);
    const rejected = yield* renderContextHandoff(
      over,
      encodeFixture({ version: 1, passageIds: over.records.slice(0, 7).map((r) => r.id) }),
    ).pipe(Effect.flip);
    assert.strictEqual(rejected.code, "selection_too_large");
  }),
);

it.effect("labels clipped anchor tails and orders anchors by source message chronology", () =>
  Effect.gen(function* () {
    const input = buildContextHandoffInput({
      title: "Anchor tails",
      messages: [
        message(
          "assistant",
          "assistant",
          "x".repeat(1_000) + "😀".repeat(1_000) + "\n\nFinal receipt: failed.",
        ),
        message("user", "user", "Wait for my approval."),
      ],
    });
    const tail = input.records.find((r) => r.text === "Final receipt: failed.")!;
    assert.include(input.prompt, "anchors are excerpts");
    assert.include(input.prompt, "select important omitted tails");
    assert.match(input.prompt, new RegExp(`\\[${tail.id}[^\\n]*anchor=not-attached`));
    assert.match(input.prompt, /user M2[^\n]*anchor=fully-attached/);
    const handoff = yield* renderContextHandoff(
      input,
      encodeFixture({ version: 1, passageIds: [tail.id] }),
    );
    assert.isBelow(
      handoff.indexOf("### user [user] M2"),
      handoff.indexOf("### assistant [assistant] M1"),
    );
    assert.include(handoff, "> Final receipt: failed.");
    assert.include(handoff, "😀");
    assert.notMatch(handoff, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    assert.notInclude(handoff, "oversized passages");
  }),
);
