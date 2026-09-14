import { MessageId, type OrchestrationMessage } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import {
  INPUT_REVIEW_HEADROOM,
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

it("retains early user constraints and initial context across large assistant history", () => {
  const input = buildContextHandoffInput({
    title: "Durable constraints",
    messages: [
      message(
        "initial-user",
        "user",
        "Every outbound reply requires /ghl; ordinary replies stay internal.",
      ),
      message("architecture", "assistant", "Use the shared provider engine."),
      message("middle", "assistant", "investigation ".repeat(12_000)),
      message(
        "receipt",
        "assistant",
        "The final live test failed; signed delivery remains unverified.",
      ),
    ],
  });
  assert.include(
    input.records.map((r) => r.source),
    "initial-user",
  );
  assert.include(
    input.records.map((r) => r.source),
    "architecture",
  );
  assert.include(
    input.records.map((r) => r.source),
    "receipt",
  );
  assert.isAtMost(input.prompt.length, 65_536);
});

it("keeps recent assistant passages contiguous outside the explicit reservations", () => {
  const input = buildContextHandoffInput({
    title: "Recent window",
    messages: [
      message("initial", "assistant", "x".repeat(10_000)),
      message("old-short", "assistant", "not in initial or recent window"),
      message("large", "assistant", "x".repeat(100_000)),
      message("last", "user", "latest"),
    ],
  });
  assert.isAbove(input.omitted, 0);
  assert.notInclude(
    input.records.map((r) => r.source),
    "old-short",
  );
  const recentIds = [...input.prompt.matchAll(/\[(P\d+) [^\n]*retention=recent;/g)].map((match) =>
    Number(match[1]!.slice(1)),
  );
  assert.strictEqual(recentIds.at(-1)! - recentIds[0]! + 1, recentIds.length);
});

it("sheds older whole user passages at the user reservation ceiling and discloses omissions", () => {
  const users = Array.from({ length: 12 }, (_, index) =>
    message(`user-${index}`, "user", `${index}:` + "u".repeat(1_200)),
  );
  const input = buildContextHandoffInput({
    title: "User overflow",
    messages: [
      message("initial", "assistant", "i".repeat(10_000)),
      ...users,
      message("middle", "assistant", "m".repeat(100_000)),
      message("receipt", "assistant", "Latest failure receipt"),
    ],
  });
  const retainedUsers = input.records.filter((r) => r.role === "user");
  assert.isAbove(retainedUsers.length, 0);
  assert.isBelow(retainedUsers.length, users.length);
  assert.deepEqual(
    retainedUsers.map((r) => r.source),
    users.slice(-retainedUsers.length).map((m) => String(m.id)),
  );
  for (const record of retainedUsers)
    assert.strictEqual(record.text, users.find((m) => String(m.id) === record.source)!.text);
  assert.include(input.prompt, `omitted user passages: ${users.length - retainedUsers.length}`);
  assert.isAtMost(input.prompt.length + INPUT_REVIEW_HEADROOM, 65_536);
  assert.strictEqual(new Set(input.records.map((r) => r.id)).size, input.records.length);
  const ids = input.records.map((r) => Number(r.id.slice(1)));
  assert.deepEqual(
    ids,
    ids.toSorted((a, b) => a - b),
  );
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

const twoPassInput = {
  cwd: "/workspace",
  title: "Coverage audit",
  messages: [
    message("old", "assistant", "Earlier proposal.\n\nFinal receipt: build failed."),
    message("user", "user", "Inspect only."),
    message("last", "assistant", "Awaiting decision."),
  ],
};
const workerOutput = (result: string, elapsedMs = 7): ProcessRunner.ProcessRunOutput => ({
  stdout: encodeFixture({
    schemaVersion: 1,
    provider: "pi",
    requestedModel: "dx2/llm",
    state: "completed",
    result,
    elapsedMs,
  }),
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

it.effect("audits the same bounded input twice and publishes only the replacement selection", () =>
  Effect.gen(function* () {
    const calls: ProcessRunner.ProcessRunInput[] = [];
    const input = {
      ...twoPassInput,
      messages: [...twoPassInput.messages, message("huge", "assistant", "x".repeat(100_000))],
    };
    const base = buildContextHandoffInput(input).prompt;
    const result = yield* prepareContextHandoff(input).pipe(
      Effect.provideService(
        ProcessRunner.ProcessRunner,
        ProcessRunner.ProcessRunner.of({
          run: (call) => {
            calls.push(call);
            return Effect.succeed(
              workerOutput(
                encodeFixture({
                  version: 1,
                  passageIds: [calls.length === 1 ? "P1" : "P2"],
                  ignored: "untrusted extras".repeat(1000),
                }),
                calls.length * 7,
              ),
            );
          },
        }),
      ),
    );
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0]!.stdin, base);
    assert.isTrue(calls[1]!.stdin!.startsWith(base));
    assert.include(calls[1]!.stdin!, '"passageIds":["P1"]');
    assert.notInclude(calls[1]!.stdin!, "untrusted extras");
    assert.isTrue(calls.every((call) => call.stdin!.length <= 65_536));
    assert.include(result.handoff, "> Final receipt: build failed.");
    assert.notInclude(result.handoff, "> Earlier proposal.");
    assert.strictEqual(result.elapsedMs, 21);
    assert.strictEqual(
      result.inputCharacters,
      calls.reduce((n, call) => n + call.stdin!.length, 0),
    );
  }),
);

it.effect("fails invalid first or second selections without retry or fallback", () =>
  Effect.gen(function* () {
    for (const invalidPass of [1, 2]) {
      let calls = 0;
      const failure = yield* prepareContextHandoff(twoPassInput).pipe(
        Effect.provideService(
          ProcessRunner.ProcessRunner,
          ProcessRunner.ProcessRunner.of({
            run: () => {
              calls++;
              return Effect.succeed(
                workerOutput(
                  encodeFixture({
                    version: 1,
                    passageIds: [calls === invalidPass ? "P999" : "P1"],
                  }),
                ),
              );
            },
          }),
        ),
        Effect.flip,
      );
      assert.strictEqual(failure.code, "invalid_source_reference");
      assert.strictEqual(calls, invalidPass);
    }
  }),
);

it.effect("shares one deadline and interrupts the second pass at the remaining limit", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>();
    const finishFirst = yield* Deferred.make<void>();
    const secondStarted = yield* Deferred.make<void>();
    const secondStopped = yield* Deferred.make<void>();
    const calls: ProcessRunner.ProcessRunInput[] = [];
    const fiber = yield* prepareContextHandoff(twoPassInput).pipe(
      Effect.provideService(
        ProcessRunner.ProcessRunner,
        ProcessRunner.ProcessRunner.of({
          run: (call) => {
            calls.push(call);
            return calls.length === 1
              ? Deferred.succeed(firstStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(finishFirst)),
                  Effect.as(workerOutput(encodeFixture({ version: 1, passageIds: ["P1"] }))),
                )
              : Deferred.succeed(secondStarted, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.ensuring(Deferred.succeed(secondStopped, undefined)),
                );
          },
        }),
      ),
      Effect.result,
      Effect.forkScoped,
    );
    yield* Deferred.await(firstStarted);
    yield* TestClock.adjust("4 minutes");
    yield* Deferred.succeed(finishFirst, undefined);
    yield* Deferred.await(secondStarted);
    assert.strictEqual(Duration.toMillis(Duration.fromInputUnsafe(calls[1]!.timeout!)), 360_000);
    yield* TestClock.adjust("6 minutes");
    const result = yield* Fiber.join(fiber);
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) assert.strictEqual(result.failure.code, "worker_timeout");
    yield* Deferred.await(secondStopped);
    assert.strictEqual(calls.length, 2);
  }).pipe(Effect.scoped),
);

it.effect("carries packing and omitted-user disclosure into the rendered report", () =>
  Effect.gen(function* () {
    const input = buildContextHandoffInput({
      title: "Omissions",
      messages: [
        message("large", "user", "x".repeat(100_000)),
        message("last", "assistant", "Waiting"),
      ],
    });
    const handoff = yield* renderContextHandoff(
      input,
      encodeFixture({ version: 1, passageIds: [input.records[0]!.id] }),
    );
    const disclosure = input.prompt.split("\n").find((line) => line.startsWith("Packing:"))!;
    assert.include(handoff, disclosure);
  }),
);

it.effect("preserves a typed audit-worker failure without publishing the first pass", () =>
  Effect.gen(function* () {
    let calls = 0;
    const failure = yield* prepareContextHandoff(twoPassInput).pipe(
      Effect.provideService(
        ProcessRunner.ProcessRunner,
        ProcessRunner.ProcessRunner.of({
          run: () => {
            calls++;
            return Effect.succeed(
              calls === 1
                ? workerOutput(encodeFixture({ version: 1, passageIds: ["P1"] }))
                : {
                    ...workerOutput(""),
                    code: ChildProcessSpawner.ExitCode(1),
                    stderr: encodeFixture({
                      code: "model_unavailable",
                      detail: "Audit unavailable",
                    }),
                  },
            );
          },
        }),
      ),
      Effect.flip,
    );
    assert.strictEqual(failure.code, "model_unavailable");
    assert.strictEqual(failure.detail, "Audit unavailable");
    assert.strictEqual(calls, 2);
  }),
);
