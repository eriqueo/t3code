import { REVIEW_PROVIDER_INSTANCE_ID, ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { CodexAppServerClientFactoryShape } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import {
  CODEX_REVIEW_LAUNCH_SCRIPT,
  CODEX_REVIEW_MODEL,
  ReviewRequirements,
  reviewEffectiveConfigSchema,
  reviewLaunchSpec,
  reviewThreadReceiptSchema,
  type CodexReviewLaunchConfig,
} from "./codexReviewPolicy.ts";

const refusal = (method: string) =>
  CodexErrors.CodexAppServerRequestError.invalidParams(
    "Review requires its verified read-only native policy.",
    undefined,
    { method, operation: "handle-request" },
  );
const driver = ProviderDriverKind.make("codex");
const encodeLaunchSpec = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const ModelInput = Schema.Struct({ model: Schema.optional(Schema.String) });
const TurnInput = Schema.Struct({
  threadId: Schema.String,
  input: Schema.Array(Schema.Unknown),
  model: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.String),
});
const ThreadInput = Schema.Struct({ threadId: Schema.String });
const NativeThread = Schema.Struct({ thread: Schema.Struct({ id: Schema.String }) });

/** One native thread per owned session, as in the original Review runtime. */
export const makeReviewRequest = (ports: {
  readonly homePath: string;
  readonly cwd: string;
  readonly request: (
    method: string,
    payload?: unknown,
  ) => Effect.Effect<unknown, CodexErrors.CodexAppServerError>;
  readonly close: Effect.Effect<void>;
}) => {
  let nativeThreadId: string | undefined;
  let closed = false;
  const decode = <A>(schema: Schema.Codec<A, unknown>, value: unknown, method: string) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => refusal(method)));
  const verify = Effect.gen(function* () {
    yield* decode(
      ReviewRequirements,
      yield* ports.request("configRequirements/read"),
      "configRequirements/read",
    );
    yield* decode(
      reviewEffectiveConfigSchema(ports.homePath),
      yield* ports.request("config/read", {
        cwd: ports.cwd,
        includeLayers: true,
      }),
      "config/read",
    );
  });
  return Effect.fn("Review.request")(
    function* (method: string, payload?: unknown) {
      if (closed) return yield* refusal(method);
      if (method === "initialize") return yield* ports.request(method, payload);
      if (method === "thread/start") {
        if (nativeThreadId !== undefined) return yield* refusal(method);
        const input = yield* decode(ModelInput, payload, method);
        if (input.model !== undefined && input.model !== CODEX_REVIEW_MODEL)
          return yield* refusal(method);
        yield* verify;
        const result = yield* ports.request(method, {
          cwd: ports.cwd,
          model: CODEX_REVIEW_MODEL,
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandbox: "read-only",
          runtimeWorkspaceRoots: [ports.cwd],
          selectedCapabilityRoots: [],
          dynamicTools: [],
        });
        yield* decode(reviewThreadReceiptSchema(ports.cwd), result, method);
        nativeThreadId = (yield* decode(NativeThread, result, method)).thread.id;
        return result;
      }
      if (method === "turn/start") {
        const input = yield* decode(TurnInput, payload, method);
        if (
          nativeThreadId === undefined ||
          input.threadId !== nativeThreadId ||
          (input.model !== undefined && input.model !== CODEX_REVIEW_MODEL)
        )
          return yield* refusal(method);
        yield* verify;
        return yield* ports.request(method, {
          threadId: nativeThreadId,
          input: input.input,
          model: CODEX_REVIEW_MODEL,
          cwd: ports.cwd,
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          runtimeWorkspaceRoots: [ports.cwd],
          ...(input.effort === undefined ? {} : { effort: input.effort }),
        });
      }
      if (
        method === "thread/read" ||
        method === "thread/unsubscribe" ||
        method === "turn/interrupt"
      ) {
        const input = yield* decode(ThreadInput, payload, method);
        if (nativeThreadId === undefined || input.threadId !== nativeThreadId)
          return yield* refusal(method);
        // These operations cannot change policy. Their typed caller validates the
        // remaining transport fields; thread identity is constrained here too.
        return yield* ports.request(method, payload);
      }
      return yield* refusal(method);
    },
    Effect.timeout("30 seconds"),
    Effect.mapError((error) =>
      error._tag === "TimeoutError" ? refusal("request-timeout") : error,
    ),
    Effect.onError(() =>
      Effect.sync(() => {
        closed = true;
      }).pipe(Effect.andThen(ports.close)),
    ),
  );
};

/** Startup-only factory. Scoped namespace launch is non-retriable. */
export const makeReviewClientFactory = Effect.fn("Review.makeClientFactory")(function* (
  launch: CodexReviewLaunchConfig,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return {
    open: (input) =>
      Effect.gen(function* () {
        if (input.instanceId !== REVIEW_PROVIDER_INSTANCE_ID) {
          return yield* new ProviderAdapter.ProviderAdapterOpenSessionError({
            driver,
            providerSessionId: input.providerSessionId,
            cause: "reserved Review identity required",
          });
        }
        const parent = yield* Scope.Scope;
        const owned = yield* Scope.make();
        const close = Scope.close(owned, Exit.void);
        yield* Scope.addFinalizer(parent, close);
        return yield* Effect.gen(function* () {
          // AUTO-MANAGED: scoped directory and 128 MiB private tmpfs are removed
          // when this owned PID namespace exits; credentials never enter logs.
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-review-" });
          yield* fs.chmod(directory, 0o700);
          const workspace = path.join(directory, "private");
          yield* fs.makeDirectory(workspace, { mode: 0o700 });
          const launcher = path.join(directory, "launch.py");
          yield* fs.writeFileString(
            launcher,
            CODEX_REVIEW_LAUNCH_SCRIPT.replace(/^#![^\n]*/, `#!${launch.pythonPath}`),
          );
          yield* fs.chmod(launcher, 0o700);
          const handle = yield* spawner.spawn(
            ChildProcess.make(launcher, ["app-server"], {
              cwd: directory,
              extendEnv: false,
              forceKillAfter: "5 seconds",
              env: {
                PATH: launch.path,
                T3_REVIEW_LAUNCH_SPEC: encodeLaunchSpec(reviewLaunchSpec(launch, workspace)),
              },
              stdin: "pipe",
              stdout: "pipe",
              stderr: "pipe",
            }),
          );
          const context = yield* Layer.build(CodexClient.layerChildProcess(handle));
          const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
            Effect.provide(context),
          );
          const request = makeReviewRequest({
            homePath: path.join(workspace, "home", "codex"),
            cwd: path.join(workspace, "neutral"),
            request: client.raw.request,
            close,
          });
          const typedRequest: CodexClient.CodexAppServerClient["Service"]["request"] = (
            method,
            payload,
          ) =>
            request(method, payload).pipe(
              Effect.flatMap((result) => {
                // Same generated response vocabulary as the ordinary client; the
                // raw response is checked for Review's extra native receipts first.
                const schema = CodexRpc.CLIENT_REQUEST_RESPONSES[method] as unknown as Schema.Codec<
                  CodexRpc.ClientRequestResponsesByMethod[typeof method],
                  unknown
                >;
                return Schema.decodeUnknownEffect(schema)(result).pipe(
                  Effect.mapError(() => refusal(method)),
                );
              }),
              Effect.onError(() => close),
            );
          return {
            ...client,
            request: typedRequest,
            raw: { ...client.raw, request },
            handleServerRequest: (method) =>
              client.handleServerRequest(method, () => refusal(method)),
            handleUnknownServerRequest: () =>
              client.handleUnknownServerRequest((method) => refusal(method)),
          } satisfies CodexClient.CodexAppServerClient["Service"];
        }).pipe(
          Effect.provideService(Scope.Scope, owned),
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
          Effect.onError(() => close),
        );
      }),
  } satisfies CodexAppServerClientFactoryShape;
});
