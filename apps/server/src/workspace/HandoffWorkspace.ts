import * as NodeCrypto from "node:crypto";
import { HandoffWorkspaceObservation } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ProcessRunner } from "../processRunner.ts";
import { checkoutInspectionEnvironment, makeCheckoutInspector } from "./LogicalProjects.ts";

const decodeObservation = Schema.decodeUnknownEffect(HandoffWorkspaceObservation);
type UnavailableCode = Extract<HandoffWorkspaceObservation, { state: "unavailable" }>["code"];

// Separate from the checkpoint copier: observing Git must never require DX2 or
// alter the frontier-authored body. This is evidence, not an execution lease.
export const makeHandoffWorkspaceObserver = Effect.gen(function* () {
  const inspect = yield* makeCheckoutInspector;
  const runner = yield* ProcessRunner;
  const environment = checkoutInspectionEnvironment(process.env);
  return Effect.fn("HandoffWorkspace.observe")(function* (cwd: string) {
    const startedAt = DateTime.formatIso(yield* DateTime.now);
    const unavailable = (code: UnavailableCode) =>
      Effect.map(DateTime.now, (time): HandoffWorkspaceObservation => ({
        version: 1,
        state: "unavailable",
        startedAt,
        completedAt: DateTime.formatIso(time),
        code,
      }));
    const collect = Effect.gen(function* () {
      const identity = yield* inspect(cwd).pipe(Effect.mapError(() => "invalid_checkout" as const));
      const status = Effect.fn("HandoffWorkspace.status")(function* () {
        const result = yield* runner
          .run({
            command: "git",
            args: [
              "-C",
              identity.checkoutPath,
              "-c",
              "core.fsmonitor=false",
              "-c",
              "core.untrackedCache=false",
              "status",
              "--porcelain=v2",
              "--branch",
              "-z",
              "--untracked-files=all",
              "--ignore-submodules=none",
            ],
            env: environment,
            timeout: "5 seconds",
            maxOutputBytes: 128 * 1024,
            // Fail at the bound; a truncated listing must never look clean.
            outputMode: "error",
          })
          .pipe(Effect.mapError(() => "inspection_failed" as const));
        if (
          result.code !== 0 ||
          result.timedOut ||
          result.stdoutTruncated ||
          result.stdoutInvalidUtf8
        )
          return yield* Effect.fail("inspection_failed" as const);
        return result.stdout;
      });
      const first = yield* status();
      const second = yield* status();
      if (first !== second) return yield* Effect.fail("changed_during_observation" as const);
      const records = second.split("\0").filter(Boolean);
      const oid = records.find((record) => record.startsWith("# branch.oid "))?.slice(13);
      const head = records.find((record) => record.startsWith("# branch.head "))?.slice(14);
      if (!oid || !head) return yield* Effect.fail("inspection_failed" as const);
      return yield* decodeObservation({
        version: 1,
        state: "observed",
        startedAt,
        completedAt: DateTime.formatIso(yield* DateTime.now),
        cwd: identity.checkoutPath,
        commonDirectory: identity.commonDirectory,
        branch: head === "(detached)" ? null : head,
        head: oid === "(initial)" ? null : oid,
        dirty: records.some((record) => !record.startsWith("# ")),
        statusDigest: NodeCrypto.createHash("sha256").update(second).digest("hex"),
      }).pipe(Effect.mapError(() => "inspection_failed" as const));
    });
    // Read-only and non-retrying. The whole observation, including identity
    // checks, has a ten-second deadline; interruption still propagates.
    const result = yield* collect.pipe(
      Effect.catch(unavailable),
      Effect.timeoutOption("10 seconds"),
    );
    return Option.isSome(result) ? result.value : yield* unavailable("timed_out");
  });
});
