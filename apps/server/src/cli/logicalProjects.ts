import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  EnvironmentHttpApi,
  LogicalProjectRegisterInput,
  LogicalProjectListInput,
  LogicalProjectResolveInput,
  LogicalProjectRegistration,
  LogicalProjectResolution,
  LogicalProjectPage,
  AuthTerminalOperateScope,
  TestRunInput,
  TestRunLookup,
  TestRunRelease,
  TestRunReceipt,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig, type CliAuthLocationFlags } from "./config.ts";

const decodeRegistrationInput = Schema.decodeEffect(
  Schema.fromJsonString(LogicalProjectRegisterInput),
);
const decodeListInput = Schema.decodeEffect(Schema.fromJsonString(LogicalProjectListInput));
const decodeResolveInput = Schema.decodeEffect(Schema.fromJsonString(LogicalProjectResolveInput));
const encodeRegistration = Schema.encodeEffect(Schema.fromJsonString(LogicalProjectRegistration));
const encodeResolution = Schema.encodeEffect(Schema.fromJsonString(LogicalProjectResolution));
const encodePage = Schema.encodeEffect(Schema.fromJsonString(LogicalProjectPage));
const decodeRun = Schema.decodeEffect(Schema.fromJsonString(TestRunInput));
const decodeRunLookup = Schema.decodeEffect(Schema.fromJsonString(TestRunLookup));
const decodeRunRelease = Schema.decodeEffect(Schema.fromJsonString(TestRunRelease));
const encodeRun = Schema.encodeEffect(Schema.fromJsonString(TestRunReceipt));

export class LogicalProjectCliUnavailable extends Schema.TaggedError<LogicalProjectCliUnavailable>()(
  "LogicalProjectCliUnavailable",
  {},
) {
  override get message() {
    return "A running T3 server is required. Start it and retry; no offline registration was performed.";
  }
}
export const requireLogicalProjectServer = <A>(state: Option.Option<A>) =>
  Option.isSome(state)
    ? Effect.succeed(state.value)
    : Effect.fail(new LogicalProjectCliUnavailable());

// The CLI is only an authenticated client. It never loads the ownership repository
// or an offline orchestration runtime, including after connection failures.
// Shared authenticated workspace CLI transport; neither command family opens
// an offline orchestration store or retries an execution request.
export const runLogicalProjectCommand = Effect.fn("workspaceCli.run")(function* (
  flags: CliAuthLocationFlags,
  operation: "register" | "list" | "resolve" | "test-run" | "test-get" | "test-release",
  json: string,
) {
  const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
  const runtime = yield* requireLogicalProjectServer(
    yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath),
  );
  return yield* Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: runtime.origin });
    const output = yield* Effect.acquireUseRelease(
      auth.issueSession({
        scopes:
          operation === "test-run" || operation === "test-release"
            ? [AuthOrchestrationReadScope, AuthTerminalOperateScope]
            : operation === "register"
              ? [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]
              : [AuthOrchestrationReadScope],
        label: operation.startsWith("test-") ? "t3 test-run cli" : "t3 logical-project cli",
      }),
      (issued) => {
        const headers = { authorization: `Bearer ${issued.token}` };
        return Effect.gen(function* () {
          if (operation === "test-run")
            return yield* encodeRun(
              yield* client.testRuns.run({ headers, payload: yield* decodeRun(json) }),
            );
          if (operation === "test-get")
            return yield* encodeRun(
              yield* client.testRuns.get({ headers, payload: yield* decodeRunLookup(json) }),
            );
          if (operation === "test-release")
            return yield* encodeRun(
              yield* client.testRuns.release({ headers, payload: yield* decodeRunRelease(json) }),
            );
          if (operation === "register") {
            const payload = yield* decodeRegistrationInput(json);
            const result = yield* client.logicalProjects.register({ headers, payload });
            return yield* encodeRegistration(result);
          }
          if (operation === "resolve") {
            const payload = yield* decodeResolveInput(json);
            const result = yield* client.logicalProjects.resolve({ headers, payload });
            return yield* encodeResolution(result);
          }
          const payload = yield* decodeListInput(json);
          const result = yield* client.logicalProjects.list({ headers, payload });
          return yield* encodePage(result);
        }).pipe(Effect.timeout(operation === "test-run" ? "13 minutes" : "15 seconds"));
      },
      (issued) => auth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
    );
    yield* Console.log(output);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        EnvironmentAuth.runtimeLayer.pipe(Layer.provide(ServerConfig.layer(config))),
        FetchHttpClient.layer,
      ),
    ),
  );
});

const command = (operation: "register" | "list" | "resolve") =>
  Command.make(operation, {
    ...projectLocationFlags,
    json: Argument.string("json").pipe(
      Argument.withDescription(
        "Versioned JSON input with explicit IDs. Registration records ownership metadata only; resolve is advisory.",
      ),
    ),
  }).pipe(Command.withHandler((flags) => runLogicalProjectCommand(flags, operation, flags.json)));
export const logicalProjectsCommand = Command.make("logical-project").pipe(
  Command.withDescription(
    "Register existing logical projects and checkouts. Does not grant execution authority or change Git state.",
  ),
  Command.withSubcommands([command("register"), command("list"), command("resolve")]),
);

export const testRunsCommand = Command.make("test-run").pipe(
  Command.withDescription(
    "Run an explicit test command once and inspect its persisted exit and workspace receipt.",
  ),
  Command.withSubcommands(
    (["run", "get", "release"] as const).map((operation) =>
      Command.make(operation, { ...projectLocationFlags, json: Argument.string("json") }).pipe(
        Command.withHandler((flags) =>
          runLogicalProjectCommand(flags, `test-${operation}`, flags.json),
        ),
      ),
    ),
  ),
);
