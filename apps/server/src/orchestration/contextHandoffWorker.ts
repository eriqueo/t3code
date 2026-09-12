import { NonNegativeInt, type OrchestrationMessage } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import * as ProcessRunner from "../processRunner.ts";

const MAX_INPUT_CHARACTERS = 65_536;
const MAX_OUTPUT_CHARACTERS = 16_384;
const WORKER_TIMEOUT = Duration.minutes(10);

const WorkerSuccess = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  provider: Schema.Literal("pi"),
  requestedModel: Schema.Literal("dx2/llm"),
  state: Schema.Literal("completed"),
  result: Schema.String,
  elapsedMs: NonNegativeInt,
});
const decodeWorkerSuccess = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkerSuccess));
const WorkerFailure = Schema.Struct({ code: Schema.String, detail: Schema.String });
const decodeWorkerFailure = Schema.decodeUnknownOption(Schema.fromJsonString(WorkerFailure));

export class ContextHandoffWorkerError extends Schema.TaggedError<ContextHandoffWorkerError>()(
  "ContextHandoffWorkerError",
  {
    code: Schema.String,
    detail: Schema.String,
  },
) {}

export interface ContextHandoffWorkerResult {
  readonly handoff: string;
  readonly elapsedMs: number;
  readonly inputCharacters: number;
  readonly outputCharacters: number;
}

function messageSection(message: Pick<OrchestrationMessage, "role" | "text">): string {
  return `${message.role.toUpperCase()}:\n${message.text.trim()}`;
}

export function buildContextHandoffPrompt(input: {
  readonly title: string;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
}): string {
  const selected: string[] = [];
  let used = 0;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (!message || message.streaming || message.text.trim().length === 0) continue;
    const section = messageSection(message);
    if (used + section.length > MAX_INPUT_CHARACTERS) continue;
    selected.unshift(section);
    used += section.length;
  }
  const transcript = selected.join("\n\n");
  return `You are a bounded evidence and compression worker. Prepare operational memory for a fresh frontier-model conversation. Do not diagnose beyond the supplied evidence. Label unverified claims and preserve exact paths, commands, test outcomes, identifiers, and user decisions. Return Markdown only, using exactly these headings:\n\n# Operational handoff\n## Objective\n## Settled decisions\n## Observed evidence\n## Current workspace state\n## Remaining work\n## Uncertainty\n## Suggested next prompt\n\nKeep the result below ${MAX_OUTPUT_CHARACTERS} characters.\n\nTHREAD TITLE:\n${input.title}\n\nBOUNDED CONVERSATION:\n${transcript}`;
}

function failureDetail(output: ProcessRunner.ProcessRunOutput): {
  readonly code: string;
  readonly detail: string;
} {
  const parsed = decodeWorkerFailure(output.stderr.trim());
  if (Option.isSome(parsed)) {
    return { code: parsed.value.code, detail: parsed.value.detail.slice(0, 1_024) };
  }
  return { code: "worker_exit", detail: `DX2 handoff worker exited with code ${output.code}.` };
}

export const prepareContextHandoff = Effect.fn("prepareContextHandoff")(function* (input: {
  readonly cwd: string;
  readonly title: string;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
}) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const prompt = buildContextHandoffPrompt(input);
  const output = yield* runner
    .run({
      command: "t3-dx2-handoff",
      args: [],
      cwd: input.cwd,
      stdin: prompt,
      timeout: WORKER_TIMEOUT,
      maxOutputBytes: 64 * 1_024,
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new ContextHandoffWorkerError({
            code: cause._tag === "ProcessTimeoutError" ? "worker_timeout" : "worker_unavailable",
            detail: cause.message.slice(0, 1_024),
          }),
      ),
    );
  if (output.code !== 0) {
    return yield* new ContextHandoffWorkerError(failureDetail(output));
  }
  const decoded = yield* decodeWorkerSuccess(output.stdout).pipe(
    Effect.mapError(
      () =>
        new ContextHandoffWorkerError({
          code: "malformed_output",
          detail: "DX2 returned an invalid handoff envelope.",
        }),
    ),
  );
  const handoff = decoded.result.trim();
  if (handoff.length === 0 || handoff.length > MAX_OUTPUT_CHARACTERS) {
    return yield* new ContextHandoffWorkerError({
      code: "output_too_large",
      detail: `DX2 handoff must contain 1-${MAX_OUTPUT_CHARACTERS} characters.`,
    });
  }
  return {
    handoff,
    elapsedMs: decoded.elapsedMs,
    inputCharacters: prompt.length,
    outputCharacters: handoff.length,
  } satisfies ContextHandoffWorkerResult;
});
