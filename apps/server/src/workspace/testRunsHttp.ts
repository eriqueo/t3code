import {
  AuthOrchestrationReadScope,
  AuthTerminalOperateScope,
  EnvironmentHttpApi,
  EnvironmentAuthenticatedPrincipal,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { requireEnvironmentScope } from "../auth/http.ts";
import { TestRuns } from "./TestRuns.ts";

export const testRunsHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "testRuns",
  Effect.fnUntraced(function* (handlers) {
    const runs = yield* TestRuns;
    return handlers
      .handle(
        "run",
        Effect.fnUntraced(function* ({ payload }) {
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          yield* requireEnvironmentScope(AuthTerminalOperateScope);
          const principal = yield* EnvironmentAuthenticatedPrincipal;
          return yield* runs.run(payload, principal.sessionId);
        }),
      )
      .handle(
        "get",
        Effect.fnUntraced(function* ({ payload }) {
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* runs.get(payload.requestId);
        }),
      )
      .handle(
        "release",
        Effect.fnUntraced(function* ({ payload }) {
          yield* requireEnvironmentScope(AuthTerminalOperateScope);
          const principal = yield* EnvironmentAuthenticatedPrincipal;
          return yield* runs.release(payload, principal.sessionId);
        }),
      );
  }),
);
