import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { ProjectId, LogicalProjectId, LogicalProjectError } from "@t3tools/contracts";
import { runMigrations } from "../persistence/Migrations.ts";
import { makeLogicalProjects } from "./LogicalProjects.ts";

it.layer(NodeSqliteClient.layerMemory())("logical project ownership", (it) => {
  it.effect(
    "registers, survives service recreation, replays atomically and rejects conflicting ownership",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('umbrella','DataX','/container','[]','now','now')`;
        const identity = {
          checkoutPath: "/outside/refinery",
          commonDirectory: "/outside/refinery/.git",
        };
        const inspect = () => Effect.succeed(identity);
        const service = yield* makeLogicalProjects(inspect);
        const input = {
          version: 1 as const,
          requestId: "request-1",
          projectId: ProjectId.make("umbrella"),
          logicalProjectId: LogicalProjectId.make("refinery"),
          title: "Refinery",
          decision: "create" as const,
          adoption: { checkoutPath: identity.checkoutPath, expected: identity },
        };
        const provenance = { actorSessionId: "admin-session", createdAt: "2026-09-14T00:00:00Z" };
        const receipt = yield* service.register(input, provenance);
        assert.strictEqual(receipt.executionAuthority, false);
        assert.deepEqual(yield* service.register(input, provenance), receipt);
        const restarted = yield* makeLogicalProjects(inspect);
        assert.strictEqual((yield* restarted.list({ projectId: input.projectId })).items.length, 1);
        assert.deepEqual(yield* restarted.register(input, provenance), receipt);
        assert.strictEqual(
          (yield* service.register({ ...input, title: "Changed" }, provenance).pipe(Effect.flip))
            .code,
          "request_conflict",
        );
        assert.strictEqual(
          (yield* service
            .register(
              { ...input, requestId: "other", logicalProjectId: LogicalProjectId.make("cloud") },
              provenance,
            )
            .pipe(Effect.flip)).code,
          "checkout_owned",
        );
        assert.strictEqual(
          (yield* service
            .register(
              {
                ...input,
                requestId: "stale",
                adoption: {
                  checkoutPath: identity.checkoutPath,
                  expected: { ...identity, commonDirectory: "/old" },
                },
              },
              provenance,
            )
            .pipe(Effect.flip)).code,
          "identity_changed",
        );
        const resolution = yield* service.resolve({
          projectId: input.projectId,
          checkoutPath: "/alias",
        });
        assert.strictEqual(resolution.advisory, true);
        assert.strictEqual(resolution.bindings.length, 1);
        assert.deepEqual(resolution.identity, identity);
        assert.strictEqual(
          (yield* sql`SELECT * FROM logical_projects WHERE logical_project_id='cloud'`).length,
          0,
        );
        assert.strictEqual(
          (yield* sql`SELECT * FROM logical_project_registration_receipts WHERE request_id='other'`)
            .length,
          0,
        );
        const unavailable = yield* makeLogicalProjects(() =>
          Effect.fail(new LogicalProjectError({ code: "invalid_checkout" })),
        );
        assert.deepEqual(yield* unavailable.register(input, provenance), receipt);
        const projects =
          yield* sql`SELECT workspace_root FROM projection_projects WHERE project_id='umbrella'`;
        assert.deepEqual(projects, [{ workspace_root: "/container" }]);
      }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("unbound identities and pagination", (it) => {
  it.effect(
    "retains unbound projects, paginates without a total cap, and rolls conflicts back",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 52 });
        yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','Parent','/container','[]','now','now')`;
        yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,runtime_mode,created_at,updated_at) VALUES('old','p','Old','{}','full-access','now','now')`;
        yield* runMigrations();
        const service = yield* makeLogicalProjects(() =>
          Effect.fail(new LogicalProjectError({ code: "invalid_checkout" })),
        );
        const provenance = { actorSessionId: "admin", createdAt: "2026-09-14T00:00:00Z" };
        for (let index = 0; index < 102; index++) {
          yield* service.register(
            {
              version: 1,
              requestId: `r${index}`,
              projectId: ProjectId.make("p"),
              logicalProjectId: LogicalProjectId.make(`logical-${String(index).padStart(3, "0")}`),
              title: "Unresolved",
              decision: "create",
            },
            provenance,
          );
        }
        const first = yield* service.list({ projectId: ProjectId.make("p") });
        assert.strictEqual(first.items.length, 100);
        assert.strictEqual(first.items[0]?.checkoutPath, null);
        assert.isNotNull(first.next);
        const second = yield* service.list({ projectId: ProjectId.make("p"), after: first.next! });
        assert.strictEqual(second.items.length, 2);
        assert.isNull(second.next);
        assert.strictEqual(
          (yield* sql`SELECT thread_id FROM projection_threads WHERE thread_id='old'`).length,
          1,
        );
        assert.strictEqual((yield* sql`SELECT * FROM logical_project_bindings`).length, 0);
      }),
  );
});

it.layer(NodeServices.layer)("competing registrations", (it) => {
  it.effect("serializes competing service instances without orphaned ownership or receipts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const firstConnection = yield* Layer.build(
        NodeSqliteClient.layer({ filename: `${directory}/ownership.sqlite` }),
      );
      const secondConnection = yield* Layer.build(
        NodeSqliteClient.layer({ filename: `${directory}/ownership.sqlite` }),
      );
      const sql = Context.get(firstConnection, SqlClient.SqlClient);
      const sql2 = Context.get(secondConnection, SqlClient.SqlClient);
      yield* runMigrations().pipe(Effect.provideService(SqlClient.SqlClient, sql));
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','Parent','/container','[]','now','now')`;
      const identity = { checkoutPath: "/repo", commonDirectory: "/repo/.git" };
      const one = yield* makeLogicalProjects(() => Effect.succeed(identity)).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      const two = yield* makeLogicalProjects(() => Effect.succeed(identity)).pipe(
        Effect.provideService(SqlClient.SqlClient, sql2),
      );
      const request = (id: string) => ({
        version: 1 as const,
        requestId: id,
        projectId: ProjectId.make("p"),
        logicalProjectId: LogicalProjectId.make(id),
        title: id,
        decision: "create" as const,
        adoption: { checkoutPath: "/repo", expected: identity },
      });
      const provenance = { actorSessionId: "admin", createdAt: "2026-09-14T00:00:00Z" };
      const outcomes = yield* Effect.all(
        [
          Effect.result(one.register(request("one"), provenance)),
          Effect.result(two.register(request("two"), provenance)),
        ],
        { concurrency: 2 },
      );
      assert.strictEqual(outcomes.filter((outcome) => outcome._tag === "Success").length, 1);
      assert.strictEqual((yield* sql`SELECT * FROM logical_projects`).length, 1);
      assert.strictEqual((yield* sql`SELECT * FROM logical_project_bindings`).length, 1);
      assert.strictEqual(
        (yield* sql`SELECT * FROM logical_project_registration_receipts`).length,
        1,
      );
    }),
  );
});
