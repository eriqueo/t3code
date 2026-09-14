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
export const runLogicalProjectCommand = Effect.fn("logicalProjectCli.run")(function* (
  flags: CliAuthLocationFlags,
  operation: "register" | "list" | "resolve",
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
          operation === "register"
            ? [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]
            : [AuthOrchestrationReadScope],
        label: "t3 logical-project cli",
      }),
      (issued) => {
        const headers = { authorization: `Bearer ${issued.token}` };
        return Effect.gen(function* () {
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
        }).pipe(Effect.timeout("15 seconds"));
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
