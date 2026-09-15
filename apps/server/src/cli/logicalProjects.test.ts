import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { resolveCliAuthConfig } from "./config.ts";
import * as NetService from "@t3tools/shared/Net";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { makeCli } from "../bin.ts";
import { GlobalFlag, Command } from "effect/unstable/cli";
import { LogicalProjectCliUnavailable, runLogicalProjectCommand } from "./logicalProjects.ts";

it.layer(Layer.mergeAll(NodeServices.layer, NetService.layer))(
  "logical project CLI live-only",
  (it) => {
    it.effect("test-run CLI refuses offline execution and creates no run store", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped();
        const error = yield* Command.runWith(makeCli(), { version: "test" })([
          "test-run",
          "run",
          "--base-dir",
          home,
          '{"version":1,"requestId":"r","threadId":"t","command":"node","args":["--version"],"timeoutSeconds":5}',
        ]).pipe(Effect.flip);
        assert.instanceOf(error, LogicalProjectCliUnavailable);
        assert.isFalse(yield* fs.exists(`${home}/userdata/state.sqlite`));
      }),
    );
    it.effect(
      "runs the production registration command without a live server and leaves no offline store",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const home = yield* fs.makeTempDirectoryScoped();
          const error = yield* Command.runWith(makeCli(), { version: "test" })([
            "logical-project",
            "register",
            "--base-dir",
            home,
            '{"version":1,"requestId":"r","projectId":"p","logicalProjectId":"cloud","title":"Cloud Engine","decision":"create"}',
          ]).pipe(Effect.flip);
          assert.instanceOf(error, LogicalProjectCliUnavailable);
          assert.strictEqual(yield* fs.exists(`${home}/userdata/state.sqlite`), false);
          assert.deepEqual(yield* fs.readDirectory(`${home}/worktrees`), []);
        }),
    );
  },
);

it.layer(Layer.mergeAll(NodeServices.layer, NetService.layer))(
  "logical project CLI disconnected",
  (it) => {
    it.effect("does not register offline after a persisted server origin refuses the request", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped();
        const config = yield* resolveCliAuthConfig({ baseDir: Option.some(home) }, Option.none());
        yield* fs.writeFileString(
          config.serverRuntimeStatePath,
          '{"version":1,"pid":1,"port":1,"origin":"http://127.0.0.1:1","startedAt":"2026-09-14T00:00:00Z"}',
        );
        yield* runLogicalProjectCommand(
          { baseDir: Option.some(home) },
          "register",
          '{"version":1,"requestId":"r","projectId":"p","logicalProjectId":"cloud","title":"Cloud Engine","decision":"create"}',
        ).pipe(Effect.provideService(GlobalFlag.LogLevel, Option.none()), Effect.flip);
        const rows = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql`SELECT * FROM logical_project_registration_receipts`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: config.dbPath })));
        assert.deepEqual(rows, []);
        assert.deepEqual(yield* fs.readDirectory(config.worktreesDir), []);
      }),
    );
  },
);
