import { REVIEW_PROVIDER_INSTANCE_ID } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as CodexErrors from "effect-codex-app-server/errors";

import type { CodexAdapterLiveOptions } from "./CodexAdapter.ts";
import { makeCodexSessionRuntime, type CodexSessionRuntimeShape } from "./CodexSessionRuntime.ts";
import {
  CODEX_REVIEW_LAUNCH_SCRIPT,
  CODEX_REVIEW_MODEL,
  type CodexReviewLaunchConfig,
  reviewLaunchSpec,
} from "./codexReviewPolicy.ts";

const encodeLaunchSpec = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const refuse = (method: string) =>
  CodexErrors.CodexAppServerRequestError.invalidParams(
    "Review does not permit this operation.",
    undefined,
    { method, operation: "handle-request" },
  );

/** Startup-owned factory. Each session gets one disposable, non-retried launch scope. */
export const makeCodexReviewRuntimeLauncher = Effect.fn("makeCodexReviewRuntimeLauncher")(
  function* (config: CodexReviewLaunchConfig) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;

    const makeRuntime: NonNullable<CodexAdapterLiveOptions["makeRuntime"]> = Effect.fn(
      "CodexReviewRuntime.makeRuntime",
    )(function* (input) {
      if (
        input.providerInstanceId !== REVIEW_PROVIDER_INSTANCE_ID ||
        input.readOnly !== true ||
        input.resumeCursor !== undefined ||
        (input.model !== undefined && input.model !== CODEX_REVIEW_MODEL) ||
        Boolean(input.launchArgs?.trim()) ||
        (input.appServerArgs?.length ?? 0) > 0 ||
        (input.mcpCapabilities?.size ?? 0) > 0 ||
        Object.keys(input.environment ?? {}).some(
          (key) => key.startsWith("T3_MCP_") || key.startsWith("AGENT_DEVICE_"),
        )
      ) {
        return yield* refuse("initialize");
      }

      // AUTO-MANAGED: scope cleanup removes the launcher and empty mount backing directory.
      // The private HOME/auth/config live only in a bounded namespace-local tmpfs.
      const prepared = yield* Effect.gen(function* () {
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-review-" });
        yield* fs.chmod(directory, 0o700);
        const workspace = path.join(directory, "private");
        yield* fs.makeDirectory(workspace, { mode: 0o700 });
        const launcher = path.join(directory, "launch.py");
        yield* fs.writeFileString(
          launcher,
          CODEX_REVIEW_LAUNCH_SCRIPT.replace(/^#![^\n]*/, `#!${config.pythonPath}`),
        );
        yield* fs.chmod(launcher, 0o700);
        return { directory, workspace, launcher };
      }).pipe(
        Effect.mapError(
          () =>
            new CodexErrors.CodexAppServerSpawnError({
              command: "controlled Review launcher",
              cause: "Review launch preparation failed.",
            }),
        ),
      );

      const homePath = path.join(prepared.workspace, "home", "codex");
      const cwd = path.join(prepared.workspace, "neutral");
      const runtime = yield* makeCodexSessionRuntime({
        threadId: input.threadId,
        providerInstanceId: input.providerInstanceId,
        readOnly: true,
        reviewPolicy: { homePath, cwd },
        launchCwd: prepared.directory,
        binaryPath: prepared.launcher,
        environment: {
          PATH: config.path,
          T3_REVIEW_LAUNCH_SPEC: encodeLaunchSpec(reviewLaunchSpec(config, prepared.workspace)),
        },
        homePath,
        cwd,
        runtimeMode: input.runtimeMode,
        model: CODEX_REVIEW_MODEL,
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));

      const guardedStart: CodexSessionRuntimeShape["start"] = () =>
        runtime.start().pipe(
          Effect.timeout("30 seconds"),
          Effect.mapError((error) =>
            error._tag === "TimeoutError" ? refuse("initialize") : error,
          ),
          Effect.onError(() => runtime.close),
        );
      const guardedSend: CodexSessionRuntimeShape["sendTurn"] = (turn) =>
        runtime.sendTurn(turn).pipe(
          Effect.timeout("30 seconds"),
          Effect.mapError((error) =>
            error._tag === "TimeoutError" ? refuse("turn/start") : error,
          ),
          Effect.onError(() => runtime.close),
        );

      return {
        ...runtime,
        start: guardedStart,
        sendTurn: guardedSend,
        compactThread: Effect.fail(refuse("thread/compact/start")),
        rollbackThread: () => Effect.fail(refuse("thread/rollback")),
        uploadFeedback: () => Effect.fail(refuse("feedback/upload")),
        respondToRequest: () => Effect.fail(refuse("item/requestApproval/decision")),
        respondToUserInput: () => Effect.fail(refuse("item/tool/requestUserInput")),
      } satisfies CodexSessionRuntimeShape;
    });
    return makeRuntime;
  },
);
