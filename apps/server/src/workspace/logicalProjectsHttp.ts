import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  EnvironmentAuthenticatedPrincipal,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { requireEnvironmentScope } from "../auth/http.ts";
import { LogicalProjects } from "./LogicalProjects.ts";

export const logicalProjectsHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "logicalProjects",
  Effect.fnUntraced(function* (handlers) {
    const projects = yield* LogicalProjects;
    return handlers
      .handle(
        "list",
        Effect.fn("logicalProjects.list")(function* (args) {
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* projects.list(args.payload);
        }),
      )
      .handle(
        "resolve",
        Effect.fn("logicalProjects.resolve")(function* (args) {
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* projects.resolve(args.payload);
        }),
      )
      .handle(
        "register",
        Effect.fn("logicalProjects.register")(function* (args) {
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const principal = yield* EnvironmentAuthenticatedPrincipal;
          return yield* projects.register(args.payload, {
            actorSessionId: principal.sessionId,
            createdAt: DateTime.formatIso(yield* DateTime.now),
          });
        }),
      );
  }),
);
