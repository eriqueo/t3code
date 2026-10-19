import {
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  ProviderInstanceId,
  REVIEW_PROVIDER_INSTANCE_ID,
  AVAILABLE_REVIEW_CAPABILITY,
  UNAVAILABLE_REVIEW_CAPABILITY,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import * as ServerConfig from "../config.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "review",
  Effect.fnUntraced(function* (handlers) {
    const config = yield* ServerConfig.ServerConfig;
    const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const platform = yield* HostProcess.Platform;
    const architecture = yield* HostProcess.Architecture;
    return handlers.handle(
      "reviewCapability",
      Effect.fn("environment.orchestration.reviewCapability")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthOrchestrationReadScope);
        if (!config.reviewLaunch || platform !== "linux" || architecture !== "x64")
          return UNAVAILABLE_REVIEW_CAPABILITY;
        const instance = yield* instances.getInstance(
          ProviderInstanceId.make(REVIEW_PROVIDER_INSTANCE_ID),
        );
        return instance?.enabled && instance.driverKind === "codex"
          ? AVAILABLE_REVIEW_CAPABILITY
          : UNAVAILABLE_REVIEW_CAPABILITY;
      }),
    );
  }),
);
