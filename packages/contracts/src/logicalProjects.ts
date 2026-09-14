import * as Schema from "effect/Schema";
import { ProjectId, TrimmedNonEmptyString, IsoDateTime } from "./baseSchemas.ts";

export const LOGICAL_PROJECT_PAGE_SIZE = 100;
const Identifier = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const LocalPath = TrimmedNonEmptyString.check(Schema.isMaxLength(4096));
export const LogicalProjectId = Identifier.pipe(Schema.brand("LogicalProjectId"));
export type LogicalProjectId = typeof LogicalProjectId.Type;
export const LocalCheckoutIdentity = Schema.Struct({
  checkoutPath: LocalPath,
  commonDirectory: LocalPath,
});
export type LocalCheckoutIdentity = typeof LocalCheckoutIdentity.Type;
export const LogicalProjectRegisterInput = Schema.Struct({
  version: Schema.Literal(1),
  requestId: Identifier,
  projectId: ProjectId,
  logicalProjectId: LogicalProjectId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(300)),
  decision: Schema.Literals(["create", "reuse"]),
  adoption: Schema.optionalKey(
    Schema.Struct({ checkoutPath: LocalPath, expected: LocalCheckoutIdentity }),
  ),
});
export type LogicalProjectRegisterInput = typeof LogicalProjectRegisterInput.Type;
export const LogicalProjectCursor = Schema.Struct({
  logicalProjectId: LogicalProjectId,
  commonDirectory: Schema.String.check(Schema.isMaxLength(4096)),
});
export const LogicalProjectListInput = Schema.Struct({
  projectId: ProjectId,
  after: Schema.optionalKey(LogicalProjectCursor),
});
export type LogicalProjectListInput = typeof LogicalProjectListInput.Type;
export const LogicalProjectResolveInput = Schema.Struct({
  projectId: ProjectId,
  checkoutPath: LocalPath,
  after: Schema.optionalKey(LogicalProjectCursor),
});
export type LogicalProjectResolveInput = typeof LogicalProjectResolveInput.Type;
export const LogicalProjectBinding = Schema.Struct({
  version: Schema.Literal(1),
  projectId: ProjectId,
  logicalProjectId: LogicalProjectId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(300)),
  checkoutPath: Schema.NullOr(LocalPath),
  commonDirectory: Schema.NullOr(LocalPath),
});
export type LogicalProjectBinding = typeof LogicalProjectBinding.Type;
export const LogicalProjectRegistration = Schema.Struct({
  version: Schema.Literal(1),
  requestId: Identifier,
  executionAuthority: Schema.Literal(false),
  binding: LogicalProjectBinding,
  actorSessionId: Identifier,
  createdAt: IsoDateTime,
});
export type LogicalProjectRegistration = typeof LogicalProjectRegistration.Type;
export const LogicalProjectPage = Schema.Struct({
  items: Schema.Array(LogicalProjectBinding).check(Schema.isMaxLength(LOGICAL_PROJECT_PAGE_SIZE)),
  next: Schema.NullOr(LogicalProjectCursor),
});
export type LogicalProjectPage = typeof LogicalProjectPage.Type;
export const LogicalProjectResolution = Schema.Struct({
  version: Schema.Literal(1),
  advisory: Schema.Literal(true),
  executionAuthority: Schema.Literal(false),
  identity: LocalCheckoutIdentity,
  bindings: Schema.Array(LogicalProjectBinding).check(
    Schema.isMaxLength(LOGICAL_PROJECT_PAGE_SIZE),
  ),
  next: Schema.NullOr(LogicalProjectCursor),
});
export type LogicalProjectResolution = typeof LogicalProjectResolution.Type;
export class LogicalProjectError extends Schema.TaggedError<LogicalProjectError>()(
  "LogicalProjectError",
  {
    code: Schema.Literals([
      "project_missing",
      "logical_project_conflict",
      "logical_project_missing",
      "checkout_owned",
      "repository_bound",
      "request_conflict",
      "identity_changed",
      "invalid_checkout",
      "storage_failed",
    ]),
  },
  { httpApiStatus: 409 },
) {
  override get message() {
    return `Logical project registration failed (${this.code}).`;
  }
}
