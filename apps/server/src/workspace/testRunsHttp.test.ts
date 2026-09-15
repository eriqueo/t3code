import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthOrchestrationReadScope,
  AuthTerminalOperateScope,
  EnvironmentHttpApi,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentAuthInvalidError,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HttpApiTest } from "effect/unstable/httpapi";
import { HttpServer, HttpServerRequest } from "effect/unstable/http";
import { ProcessRunner, layer as processLayer } from "../processRunner.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { TestRuns, makeTestRuns } from "./TestRuns.ts";
import { testRunsHttpApiLayer } from "./testRunsHttp.ts";

const auth = Layer.succeed(EnvironmentAuthenticatedAuth, (httpEffect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const credential = request.headers.authorization;
    if (credential !== "Bearer read" && credential !== "Bearer execute")
      return yield* new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "missing_credential",
        traceId: "test",
      });
    return yield* httpEffect.pipe(
      Effect.provideService(EnvironmentAuthenticatedPrincipal, {
        sessionId: AuthSessionId.make("http-actor"),
        subject: "test",
        method: "bearer-access-token",
        scopes: new Set(
          credential === "Bearer execute"
            ? [AuthOrchestrationReadScope, AuthTerminalOperateScope]
            : [AuthOrchestrationReadScope],
        ),
      }),
    );
  }),
);
const service = Layer.effect(
  TestRuns,
  Effect.gen(function* () {
    yield* runMigrations();
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const runner = yield* ProcessRunner;
    assert.strictEqual(
      (yield* runner.run({ command: "git", args: ["init", "--initial-branch=main", root] })).code,
      0,
    );
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','Test',${root},'[]','now','now')`;
    yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,created_at,updated_at) VALUES('t','p','Test','{}','now','now')`;
    return yield* makeTestRuns;
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeSqliteClient.layerMemory(),
      processLayer.pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  ),
);

it.layer(
  Layer.mergeAll(
    testRunsHttpApiLayer.pipe(Layer.provide(service), Layer.provideMerge(auth)),
    HttpServer.layerServices,
  ),
)("test run HTTP production path", (it) => {
  it.effect(
    "denies read-only execution and release, then runs and retrieves the actual persisted exit",
    () =>
      Effect.gen(function* () {
        const client = yield* HttpApiTest.groups(EnvironmentHttpApi, ["testRuns"]);
        const payload = {
          version: 1 as const,
          requestId: "http",
          threadId: ThreadId.make("t"),
          command: process.execPath,
          args: ["-e", "process.exit(9)"],
          timeoutSeconds: 5,
        };
        yield* client.testRuns.run({ headers: {}, payload }).pipe(Effect.flip);
        yield* client.testRuns
          .run({ headers: { authorization: "Bearer read" }, payload })
          .pipe(Effect.flip);
        yield* client.testRuns
          .get({ headers: { authorization: "Bearer read" }, payload: { requestId: "http" } })
          .pipe(Effect.flip);
        const receipt = yield* client.testRuns.run({
          headers: { authorization: "Bearer execute" },
          payload,
        });
        assert.strictEqual(receipt.exitCode, 9);
        assert.strictEqual(receipt.actorSessionId, "http-actor");
        assert.strictEqual(receipt.revisionValidity, "matching_observations");
        assert.deepEqual(
          yield* client.testRuns.get({
            headers: { authorization: "Bearer read" },
            payload: { requestId: "http" },
          }),
          receipt,
        );
        assert.deepEqual(
          yield* client.testRuns.run({ headers: { authorization: "Bearer execute" }, payload }),
          receipt,
        );
        yield* client.testRuns
          .release({
            headers: { authorization: "Bearer read" },
            payload: { requestId: "http", processStopped: true },
          })
          .pipe(Effect.flip);
      }),
  );
});
