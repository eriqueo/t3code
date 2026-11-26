// Fork: HTTP twin of the WebSocket `orchestration.dispatchCommand` handler in
// ws.ts, for host-local callers that hold a bearer but no WebSocket client
// (the tracker relay). It runs the same intake path, so command receipts make a
// repeated commandId return its first result instead of acting twice.
import {
  AuthOrchestrationOperateScope,
  AuthProvidersManageScope,
  EnvironmentHttpApi,
  ORCHESTRATION_V2_WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ServerConfig from "../config.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadMessageIntake from "./ThreadMessageIntake.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import { requiredScopesForRpcCall } from "../auth/RpcAuthorization.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestrationDispatch",
  Effect.fnUntraced(function* (handlers) {
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
    const launches = yield* ThreadLaunchService.ThreadLaunchService;
    const intakeContext = yield* Effect.context<
      | ThreadManagementService.ThreadManagementService
      | ThreadLaunchService.ThreadLaunchService
      | FileSystem.FileSystem
      | ServerConfig.ServerConfig
      | ServerSettings.ServerSettingsService
      | DocumentText.DocumentText
    >();

    return handlers.handle(
      "dispatch",
      Effect.fn("environment.orchestration.dispatch")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        const session = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
        const command = args.payload;
        for (const scope of requiredScopesForRpcCall(
          ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
          command,
        )) {
          if (!session.scopes.has(scope)) return yield* failEnvironmentScopeRequired(scope);
        }
        return yield* startup
          .enqueueCommand(
            (command.type === "prepared-run.retry"
              ? launches.retryPreparation(command)
              : ThreadMessageIntake.dispatchCommand(
                  ThreadManagementService.withCreationProvenance(command, {
                    createdBy: "user",
                    creationSource: "creationSource" in command ? command.creationSource : "web",
                  }),
                  { managesProviders: session.scopes.has(AuthProvidersManageScope) },
                )
            ).pipe(Effect.provide(intakeContext)),
          )
          .pipe(
            Effect.map((result) => ({ sequence: result.sequence })),
            Effect.catch(
              Effect.fnUntraced(function* (cause) {
                if (cause._tag === "EnvironmentAuthorizationError") {
                  return yield* failEnvironmentScopeRequired(cause.requiredScope);
                }
                return yield* failEnvironmentInternal("orchestration_dispatch_failed", cause);
              }),
            ),
          );
      }),
    );
  }),
);
