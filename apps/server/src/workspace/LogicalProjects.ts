import {
  LOGICAL_PROJECT_PAGE_SIZE,
  LogicalProjectBinding,
  LogicalProjectError,
  LogicalProjectRegistration,
  type LogicalProjectPage,
  type LocalCheckoutIdentity,
  type LogicalProjectListInput,
  type LogicalProjectRegisterInput,
  type LogicalProjectResolveInput,
  type LogicalProjectResolution,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProcessRunner } from "../processRunner.ts";

const decodeBindings = Schema.decodeUnknownEffect(Schema.Array(LogicalProjectBinding));
const decodeReceipt = Schema.decodeEffect(Schema.fromJsonString(LogicalProjectRegistration));
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(LogicalProjectRegistration));
const encodeFingerprint = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.NullOr(Schema.Union([Schema.String, Schema.Finite])))),
);

const failure = (code: LogicalProjectError["code"]) => new LogicalProjectError({ code });
const storageFailure = () => failure("storage_failed");

export const checkoutInspectionEnvironment = (environment: NodeJS.ProcessEnv) => ({
  ...Object.fromEntries(
    Object.keys(environment)
      .filter((key) => key.startsWith("GIT_"))
      .map((key) => [key, undefined]),
  ),
  GIT_OPTIONAL_LOCKS: "0",
});

// Read-only Git inspection. Common-directory realpath distinguishes independent clones
// while sharing identity across linked worktrees. Umbrella paths impose no ancestry rule.
export const makeCheckoutInspector = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner;
  // Composition boundary: explicitly clear all ambient Git routing/config variables.
  const gitEnvironment = checkoutInspectionEnvironment(process.env);
  return Effect.fn("LogicalProjects.inspect")(function* (checkoutPath: string) {
    const canonical = yield* fs
      .realPath(checkoutPath)
      .pipe(Effect.mapError(() => failure("invalid_checkout")));
    const query = Effect.fn("LogicalProjects.gitIdentity")(function* (args: ReadonlyArray<string>) {
      const result = yield* runner
        .run({
          command: "git",
          args: ["-C", canonical, ...args],
          env: gitEnvironment,
          timeout: "5 seconds",
          timeoutBehavior: "timedOutResult",
          maxOutputBytes: 1024 * 1024,
        })
        .pipe(Effect.mapError(() => failure("invalid_checkout")));
      if (
        result.code !== 0 ||
        result.timedOut ||
        result.stdoutTruncated ||
        result.stdoutInvalidUtf8
      )
        return yield* failure("invalid_checkout");
      return result.stdout;
    });
    const read = Effect.fn("LogicalProjects.gitPath")(function* (flag: string) {
      const value = yield* query(["rev-parse", "--path-format=absolute", flag]);
      return yield* fs
        .realPath(value.trim())
        .pipe(Effect.mapError(() => failure("invalid_checkout")));
    });
    const root = yield* read("--show-toplevel");
    if (root !== canonical) return yield* failure("invalid_checkout");
    const commonDirectory = yield* read("--git-common-dir");
    const gitDirectory = yield* read("--absolute-git-dir");
    if (gitDirectory !== commonDirectory) {
      // A copied .git pointer can borrow another worktree's index/HEAD while
      // rev-parse still reports this directory as its root. Require the backlink.
      const backlink = yield* fs
        .readFileString(`${gitDirectory}/gitdir`)
        .pipe(Effect.mapError(() => failure("invalid_checkout")));
      const canonicalBacklink = yield* fs
        .realPath(path.resolve(gitDirectory, backlink.trim()))
        .pipe(Effect.mapError(() => failure("invalid_checkout")));
      // Do not follow this pointer: a symlink to a sibling's .git must not
      // make that sibling's backlink appear to belong to this checkout.
      const ownPointer = path.join(root, ".git");
      if (canonicalBacklink !== ownPointer) return yield* failure("invalid_checkout");
    }
    const registry = yield* query(["worktree", "list", "--porcelain", "-z"]);
    const registered = registry
      .split("\0")
      .filter((field) => field.startsWith("worktree "))
      .map((field) => field.slice(9));
    let present = false;
    for (const registeredPath of registered) {
      const real = yield* fs.realPath(registeredPath).pipe(Effect.orElseSucceed(() => null));
      if (real === root) present = true;
    }
    if (!present) return yield* failure("invalid_checkout");
    return { checkoutPath: root, commonDirectory } satisfies LocalCheckoutIdentity;
  });
});

type Inspect = (path: string) => Effect.Effect<LocalCheckoutIdentity, LogicalProjectError>;
export const makeLogicalProjects = Effect.fn("makeLogicalProjects")(function* (inspect: Inspect) {
  const sql = yield* SqlClient.SqlClient;
  const list = Effect.fn("LogicalProjects.list")(function* (
    input: LogicalProjectListInput,
    commonDirectory?: string,
  ) {
    const rows =
      yield* sql`SELECT l.version, l.project_id AS "projectId", l.logical_project_id AS "logicalProjectId", l.title,
      b.checkout_path AS "checkoutPath", b.common_directory AS "commonDirectory"
      FROM logical_projects l LEFT JOIN logical_project_bindings b USING(logical_project_id)
      WHERE l.project_id=${input.projectId}
      AND (${commonDirectory ?? null} IS NULL OR b.common_directory=${commonDirectory ?? null})
      AND (l.logical_project_id > ${input.after?.logicalProjectId ?? ""} OR (l.logical_project_id=${input.after?.logicalProjectId ?? ""} AND COALESCE(b.common_directory,'') > ${input.after?.commonDirectory ?? ""}))
      ORDER BY l.logical_project_id,COALESCE(b.common_directory,'') LIMIT ${LOGICAL_PROJECT_PAGE_SIZE + 1}`.pipe(
        Effect.mapError(storageFailure),
      );
    const decoded = yield* decodeBindings(rows).pipe(Effect.mapError(storageFailure));
    // Transport bound only: callers traverse every row through the stable keyset cursor.
    const items = decoded.slice(0, LOGICAL_PROJECT_PAGE_SIZE);
    const last = items.at(-1);
    return {
      items,
      next:
        decoded.length > LOGICAL_PROJECT_PAGE_SIZE && last
          ? { logicalProjectId: last.logicalProjectId, commonDirectory: last.commonDirectory ?? "" }
          : null,
    };
  });
  const resolve = Effect.fn("LogicalProjects.resolve")(function* (
    input: LogicalProjectResolveInput,
  ) {
    const identity = yield* inspect(input.checkoutPath);
    const page = yield* list(input, identity.commonDirectory);
    return {
      version: 1,
      advisory: true,
      executionAuthority: false,
      identity,
      bindings: page.items,
      next: page.next,
    } satisfies LogicalProjectResolution;
  });
  const register = Effect.fn("LogicalProjects.register")(function* (
    input: LogicalProjectRegisterInput,
    provenance: { actorSessionId: string; createdAt: string },
  ) {
    // Fixed field order: transport key order does not change request identity.
    const fingerprint = yield* encodeFingerprint([
      input.version,
      input.projectId,
      input.logicalProjectId,
      input.title,
      input.decision,
      input.adoption?.checkoutPath ?? null,
      input.adoption?.expected.checkoutPath ?? null,
      input.adoption?.expected.commonDirectory ?? null,
    ]).pipe(Effect.mapError(storageFailure));
    const prior = yield* sql<{
      input_json: string;
      receipt_json: string;
    }>`SELECT input_json,receipt_json FROM logical_project_registration_receipts WHERE request_id=${input.requestId}`.pipe(
      Effect.mapError(storageFailure),
    );
    if (prior[0]) {
      if (prior[0].input_json !== fingerprint) return yield* failure("request_conflict");
      return yield* decodeReceipt(prior[0].receipt_json).pipe(Effect.mapError(storageFailure));
    }
    // This is an observation for registration, never continuing filesystem authority.
    // Inspect before the write transaction so Git cannot block unrelated SQLite writes.
    const identity = input.adoption ? yield* inspect(input.adoption.checkoutPath) : null;
    if (
      identity &&
      input.adoption &&
      (identity.checkoutPath !== input.adoption.expected.checkoutPath ||
        identity.commonDirectory !== input.adoption.expected.commonDirectory)
    )
      return yield* failure("identity_changed");
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          // First statement is a write: serialize independent connections before checking
          // ownership. The receipt and metadata commit together; failures roll back both.
          yield* sql`INSERT INTO logical_project_registration_receipts(request_id,input_json,receipt_json)
        VALUES(${input.requestId},${fingerprint},'null') ON CONFLICT(request_id) DO NOTHING`;
          const rows = yield* sql<{
            input_json: string;
            receipt_json: string;
          }>`SELECT input_json,receipt_json FROM logical_project_registration_receipts WHERE request_id=${input.requestId}`;
          const existing = rows[0];
          if (!existing || existing.input_json !== fingerprint)
            return yield* failure("request_conflict");
          if (existing.receipt_json !== "null")
            return yield* decodeReceipt(existing.receipt_json).pipe(
              Effect.mapError(storageFailure),
            );
          const projects =
            yield* sql`SELECT project_id FROM projection_projects WHERE project_id=${input.projectId} AND deleted_at IS NULL`;
          if (projects.length === 0) return yield* failure("project_missing");
          const owners = yield* sql<{
            logical_project_id: string;
          }>`SELECT logical_project_id FROM logical_project_bindings WHERE checkout_path=${identity?.checkoutPath ?? null}`;
          if (owners.some((owner) => owner.logical_project_id !== input.logicalProjectId))
            return yield* failure("checkout_owned");
          const logical = yield* sql<{
            project_id: string;
            title: string;
          }>`SELECT project_id,title FROM logical_projects WHERE logical_project_id=${input.logicalProjectId}`;
          if (input.decision === "create" && logical.length > 0)
            return yield* failure("logical_project_conflict");
          if (input.decision === "reuse" && logical.length === 0)
            return yield* failure("logical_project_missing");
          if (logical.some((l) => l.project_id !== input.projectId || l.title !== input.title))
            return yield* failure("logical_project_conflict");
          const bindings = yield* sql<{
            checkout_path: string;
          }>`SELECT checkout_path FROM logical_project_bindings WHERE logical_project_id=${input.logicalProjectId} AND common_directory=${identity?.commonDirectory ?? null}`;
          if (bindings.some((b) => b.checkout_path !== identity?.checkoutPath))
            return yield* failure("repository_bound");
          if (logical.length === 0)
            yield* sql`INSERT INTO logical_projects(logical_project_id,project_id,title,version) VALUES(${input.logicalProjectId},${input.projectId},${input.title},1)`;
          if (identity && bindings.length === 0)
            yield* sql`INSERT INTO logical_project_bindings(logical_project_id,common_directory,checkout_path) VALUES(${input.logicalProjectId},${identity?.commonDirectory ?? null},${identity?.checkoutPath ?? null})`;
          const receipt: LogicalProjectRegistration = {
            version: 1,
            requestId: input.requestId,
            executionAuthority: false,
            ...provenance,
            binding: {
              version: 1,
              projectId: input.projectId,
              logicalProjectId: input.logicalProjectId,
              title: input.title,
              checkoutPath: identity?.checkoutPath ?? null,
              commonDirectory: identity?.commonDirectory ?? null,
            },
          };
          const encoded = yield* encodeReceipt(receipt).pipe(Effect.mapError(storageFailure));
          yield* sql`UPDATE logical_project_registration_receipts SET receipt_json=${encoded} WHERE request_id=${input.requestId}`;
          return receipt;
        }),
      )
      .pipe(Effect.catchTag("SqlError", () => Effect.fail(storageFailure())));
  });
  return { register, list, resolve };
});
export class LogicalProjects extends Context.Service<
  LogicalProjects,
  {
    readonly register: (
      input: LogicalProjectRegisterInput,
      provenance: { actorSessionId: string; createdAt: string },
    ) => Effect.Effect<LogicalProjectRegistration, LogicalProjectError>;
    readonly list: (
      input: LogicalProjectListInput,
    ) => Effect.Effect<LogicalProjectPage, LogicalProjectError>;
    readonly resolve: (
      input: LogicalProjectResolveInput,
    ) => Effect.Effect<LogicalProjectResolution, LogicalProjectError>;
  }
>()("t3/workspace/LogicalProjects") {}
export const layer = Layer.effect(
  LogicalProjects,
  Effect.gen(function* () {
    return yield* makeLogicalProjects(yield* makeCheckoutInspector);
  }),
);
