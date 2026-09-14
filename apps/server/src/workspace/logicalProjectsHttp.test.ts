import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  EnvironmentHttpApi,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentAuthInvalidError,
  ProjectId,
  LogicalProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpApiTest } from "effect/unstable/httpapi";
import { HttpServer, HttpServerRequest } from "effect/unstable/http";
import { logicalProjectsHttpApiLayer } from "./logicalProjectsHttp.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { LogicalProjects, makeLogicalProjects } from "./LogicalProjects.ts";

const auth = Layer.succeed(EnvironmentAuthenticatedAuth, (httpEffect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const credential = request.headers.authorization;
    if (credential !== "Bearer read" && credential !== "Bearer write")
      return yield* new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "missing_credential",
        traceId: "test",
      });
    return yield* httpEffect.pipe(
      Effect.provideService(EnvironmentAuthenticatedPrincipal, {
        sessionId: AuthSessionId.make("authenticated-actor"),
        subject: "test",
        method: "bearer-access-token",
        scopes: new Set(
          credential === "Bearer write"
            ? [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]
            : [AuthOrchestrationReadScope],
        ),
      }),
    );
  }),
);
const service = Layer.effect(
  LogicalProjects,
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','Parent','/container','[]','now','now')`;
    return yield* makeLogicalProjects(() =>
      Effect.succeed({ checkoutPath: "/repo", commonDirectory: "/repo/.git" }),
    );
  }),
).pipe(Layer.provide(NodeSqliteClient.layerMemory()));
it.layer(
  Layer.mergeAll(
    logicalProjectsHttpApiLayer.pipe(Layer.provide(service), Layer.provideMerge(auth)),
    HttpServer.layerServices,
  ),
)("logical projects HTTP", (it) => {
  it.effect(
    "requires authentication and write scope; records server actor rather than execution authority",
    () =>
      Effect.gen(function* () {
        const client = yield* HttpApiTest.groups(EnvironmentHttpApi, ["logicalProjects"]);
        const payload = {
          version: 1 as const,
          requestId: "r",
          projectId: ProjectId.make("p"),
          logicalProjectId: LogicalProjectId.make("cloud"),
          title: "Cloud Engine",
          decision: "create" as const,
        };
        yield* client.logicalProjects
          .list({ headers: {}, payload: { projectId: payload.projectId } })
          .pipe(Effect.flip);
        yield* client.logicalProjects
          .register({ headers: { authorization: "Bearer read" }, payload })
          .pipe(Effect.flip);
        assert.deepEqual(
          yield* client.logicalProjects.list({
            headers: { authorization: "Bearer read" },
            payload: { projectId: payload.projectId },
          }),
          { items: [], next: null },
        );
        const receipt = yield* client.logicalProjects.register({
          headers: { authorization: "Bearer write" },
          payload,
        });
        assert.strictEqual(receipt.actorSessionId, "authenticated-actor");
        assert.strictEqual(receipt.executionAuthority, false);
        assert.deepEqual(
          yield* client.logicalProjects.register({
            headers: { authorization: "Bearer write" },
            payload,
          }),
          receipt,
        );
        const listed = yield* client.logicalProjects.list({
          headers: { authorization: "Bearer read" },
          payload: { projectId: payload.projectId },
        });
        assert.deepEqual(listed.items, [receipt.binding]);
      }),
  );
});
