// @effect-diagnostics nodeBuiltinImport:off - this filesystem adapter needs lstat, O_NOFOLLOW and descriptor identity checks around bounded reads.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { TestWorkspaceFingerprint } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ProcessRunner } from "../processRunner.ts";
import { checkoutInspectionEnvironment } from "./LogicalProjects.ts";
import { makeHandoffWorkspaceObserver } from "./HandoffWorkspace.ts";

type Code = Extract<TestWorkspaceFingerprint, { state: "unavailable" }>["code"];
// Bounds shed the observation, never silently omit a file. Sequential reads
// bound memory to one 32 MiB file. Ignored inputs and submodules are not certified.
const MAX_FILES = 100_000;
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
export const makeTestWorkspaceObserver = Effect.gen(function* () {
  const observe = yield* makeHandoffWorkspaceObserver;
  const runner = yield* ProcessRunner;
  const env = checkoutInspectionEnvironment(process.env);
  return Effect.fn("TestWorkspace.observe")(function* (cwd: string) {
    const unavailable = (code: Code) =>
      Effect.map(DateTime.now, (time): TestWorkspaceFingerprint => ({
        version: 1,
        state: "unavailable",
        capturedAt: DateTime.formatIso(time),
        code,
      }));
    const collect = Effect.gen(function* () {
      const before = yield* observe(cwd);
      if (before.state !== "observed") return yield* Effect.fail("inspection_failed" as const);
      const list = Effect.fnUntraced(function* () {
        const result = yield* runner.run({
          command: "git",
          args: ["-C", before.cwd, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
          env,
          timeout: "5 seconds",
          maxOutputBytes: 8 * 1024 * 1024,
          outputMode: "error",
        });
        if (
          result.code !== 0 ||
          result.stdoutInvalidUtf8 ||
          result.stdoutTruncated ||
          result.timedOut
        )
          return yield* Effect.fail("inspection_failed" as const);
        return result.stdout;
      });
      const listing = yield* list();
      const files = [...new Set(listing.split("\0").filter(Boolean))].sort();
      if (files.length > MAX_FILES) return yield* Effect.fail("limit_exceeded" as const);
      const content = yield* Effect.tryPromise({
        try: async (signal) => {
          const hash = NodeCrypto.createHash("sha256");
          let bytes = 0;
          const field = (value: string | Uint8Array) => {
            hash.update(String(Buffer.byteLength(value)));
            hash.update(":");
            hash.update(value);
          };
          for (const file of files) {
            signal.throwIfAborted();
            const path = NodePath.resolve(before.cwd, file);
            if (!path.startsWith(before.cwd + NodePath.sep)) throw "unsupported_file";
            // Check ancestors before touching contents. This observes identity;
            // it is not a filesystem confinement boundary against hostile races.
            let parent;
            try {
              parent = await NodeFSP.realpath(NodePath.dirname(path));
            } catch (error) {
              if (
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code === "ENOENT"
              ) {
                field(file);
                field("deleted");
                continue;
              }
              throw error;
            }
            if (parent !== before.cwd && !parent.startsWith(before.cwd + NodePath.sep))
              throw "unsupported_file";
            field(file);
            let stat;
            try {
              stat = await NodeFSP.lstat(path);
            } catch (error) {
              if (
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code === "ENOENT"
              ) {
                field("deleted");
                continue;
              }
              throw error;
            }
            field(String(stat.mode));
            if (stat.isSymbolicLink()) {
              field(await NodeFSP.readlink(path));
              continue;
            }
            if (!stat.isFile()) throw "unsupported_file";
            bytes += stat.size;
            if (bytes > MAX_BYTES || stat.size > MAX_FILE_BYTES) throw "limit_exceeded";
            const handle = await NodeFSP.open(
              path,
              NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
            );
            try {
              const opened = await handle.stat();
              if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev)
                throw "changed_during_observation";
              const data = Buffer.alloc(stat.size);
              let offset = 0;
              while (offset < data.length) {
                signal.throwIfAborted();
                const read = await handle.read(
                  data,
                  offset,
                  Math.min(64 * 1024, data.length - offset),
                  offset,
                );
                if (read.bytesRead === 0) throw "changed_during_observation";
                offset += read.bytesRead;
              }
              field(data);
              const after = await handle.stat();
              if (
                after.mtimeMs !== stat.mtimeMs ||
                after.ctimeMs !== stat.ctimeMs ||
                after.size !== stat.size
              )
                throw "changed_during_observation";
              const current = await NodeFSP.lstat(path);
              if (current.ino !== stat.ino || current.dev !== stat.dev)
                throw "changed_during_observation";
            } finally {
              await handle.close();
            }
          }
          return { digest: hash.digest("hex"), fileCount: files.length, bytes };
        },
        catch: (error): Code =>
          typeof error === "string" &&
          ["limit_exceeded", "unsupported_file", "changed_during_observation"].includes(error)
            ? (error as Code)
            : "inspection_failed",
      });
      if (listing !== (yield* list()))
        return yield* Effect.fail("changed_during_observation" as const);
      const after = yield* observe(cwd);
      if (
        after.state !== "observed" ||
        after.head !== before.head ||
        after.statusDigest !== before.statusDigest ||
        after.commonDirectory !== before.commonDirectory ||
        after.cwd !== before.cwd
      )
        return yield* Effect.fail("changed_during_observation" as const);
      return {
        version: 1,
        state: "observed",
        capturedAt: DateTime.formatIso(yield* DateTime.now),
        cwd: before.cwd,
        commonDirectory: before.commonDirectory,
        head: before.head,
        branch: before.branch,
        dirty: before.dirty,
        statusDigest: before.statusDigest,
        scope: "tracked_and_nonignored_untracked",
        ...content,
      } satisfies TestWorkspaceFingerprint;
    });
    const result = yield* collect.pipe(
      Effect.catch((error) => unavailable(typeof error === "string" ? error : "inspection_failed")),
      Effect.timeoutOption("60 seconds"),
    );
    return Option.isSome(result) ? result.value : yield* unavailable("timed_out");
  });
});
