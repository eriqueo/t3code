import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentAuthInvalidError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpApiTest } from "effect/http-api";
import { HttpServer, HttpServerRequest } from "effect/http";
import * as ServerConfig from "../config.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Registry from "./ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ReviewHttp from "./reviewHttp.ts";

const auth = Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!request.headers.authorization)
      return yield* new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "missing_credential",
        traceId: "test",
      });
    return yield* effect.pipe(
      Effect.provideService(EnvironmentAuthenticatedPrincipal, {
        sessionId: AuthSessionId.make("test"),
        subject: "test",
        method: "bearer-access-token",
        scopes: new Set(
          request.headers.authorization === "Bearer read" ? [AuthOrchestrationReadScope] : [],
        ),
      }),
    );
  }),
);

it.effect.each([false, true])(
  "reports the trusted Review registry state, available=%s",
  (available) => {
    const config = Layer.effect(
      ServerConfig.ServerConfig,
      Effect.map(ServerConfig.ServerConfig, (current) => ({
        ...current,
        reviewLaunch: {
          nativeDirectory: "/nix/store/test",
          pythonPath: "/fixture/python",
          mountPath: "/fixture/mount",
          unsharePath: "/fixture/unshare",
          authSource: "/fixture/account",
          path: "/fixture/bin",
        },
      })),
    ).pipe(
      Layer.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "review-http-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
    const routes = ReviewHttp.layer.pipe(
      Layer.provide(config),
      Layer.provideMerge(auth),
      Layer.provide(
        Layer.mock(Registry.ProviderInstanceRegistry)({
          getInstance: () =>
            Effect.succeed(
              available ? ({ enabled: true, driverKind: "codex" } as ProviderInstance) : undefined,
            ),
        }),
      ),
    );
    return Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(EnvironmentHttpApi, ["review"]);
      const denied = yield* Effect.result(client.review.reviewCapability({ headers: {} }));
      assert.equal(denied._tag, "Failure");
      const noScope = yield* Effect.result(
        client.review.reviewCapability({ headers: { authorization: "Bearer none" } }),
      );
      assert.equal(noScope._tag, "Failure");
      const capability = yield* client.review.reviewCapability({
        headers: { authorization: "Bearer read" },
      });
      assert.equal(capability.available, available);
      assert.equal(capability.instanceId, "codex_review");
    }).pipe(
      Effect.provide(Layer.mergeAll(routes, NodeServices.layer, HttpServer.layerServices)),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Architecture, "x64"),
    );
  },
);
