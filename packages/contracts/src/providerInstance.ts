import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const PROVIDER_SLUG_MAX_CHARS = 64;
const PROVIDER_SLUG_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const ENVIRONMENT_VARIABLE_NAME_MAX_CHARS = 128;
const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const slugSchema = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROVIDER_SLUG_MAX_CHARS),
  Schema.isPattern(PROVIDER_SLUG_PATTERN),
);

export const ProviderDriverKind = slugSchema.pipe(Schema.brand("ProviderDriverKind"));
export type ProviderDriverKind = typeof ProviderDriverKind.Type;

const isProviderDriverKindValue = Schema.is(ProviderDriverKind);
export const isProviderDriverKind = (value: unknown): value is ProviderDriverKind =>
  isProviderDriverKindValue(value);

export const ProviderInstanceId = slugSchema.pipe(Schema.brand("ProviderInstanceId"));
export type ProviderInstanceId = typeof ProviderInstanceId.Type;

export const REVIEW_PROVIDER_INSTANCE_ID = "codex_review";

export const REVIEW_MODEL_ID = "gpt-6.1-sol";

// Old readers keep the denial packet. A grant names the exact tested native,
// result and termination policy; unknown versions must not authorize launch.
const UnavailableReviewCapability = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  available: Schema.Literal(false),
  instanceId: Schema.Literal(REVIEW_PROVIDER_INSTANCE_ID),
  driver: Schema.Literal("codex"),
  reason: Schema.Literal("containment_unverified"),
});
const AvailableReviewCapability = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  available: Schema.Literal(true),
  instanceId: Schema.Literal(REVIEW_PROVIDER_INSTANCE_ID),
  driver: Schema.Literal("codex"),
  model: Schema.Literal(REVIEW_MODEL_ID),
  policy: Schema.Literal("linux-private-native-read-only-v1"),
  resultSchemaVersion: Schema.Literal(1),
  termination: Schema.Literal("owned-pid-namespace-v1"),
});
export const ReviewCapability = Schema.Union([
  UnavailableReviewCapability,
  AvailableReviewCapability,
]);
export type ReviewCapability = typeof ReviewCapability.Type;

export const UNAVAILABLE_REVIEW_CAPABILITY: typeof UnavailableReviewCapability.Type = Object.freeze(
  {
    schemaVersion: 1,
    available: false,
    instanceId: REVIEW_PROVIDER_INSTANCE_ID,
    driver: "codex",
    reason: "containment_unverified",
  },
);
export const AVAILABLE_REVIEW_CAPABILITY: typeof AvailableReviewCapability.Type = Object.freeze({
  schemaVersion: 2,
  available: true,
  instanceId: REVIEW_PROVIDER_INSTANCE_ID,
  driver: "codex",
  model: REVIEW_MODEL_ID,
  policy: "linux-private-native-read-only-v1",
  resultSchemaVersion: 1,
  termination: "owned-pid-namespace-v1",
});

export const ProviderInstanceRef = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
});
export type ProviderInstanceRef = typeof ProviderInstanceRef.Type;

export const ProviderInstanceEnvironmentVariableName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(ENVIRONMENT_VARIABLE_NAME_MAX_CHARS),
  Schema.isPattern(ENVIRONMENT_VARIABLE_NAME_PATTERN),
);
export type ProviderInstanceEnvironmentVariableName =
  typeof ProviderInstanceEnvironmentVariableName.Type;

export const ProviderInstanceEnvironmentVariable = Schema.Struct({
  name: ProviderInstanceEnvironmentVariableName,
  value: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  sensitive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  valueRedacted: Schema.optionalKey(Schema.Boolean),
});
export type ProviderInstanceEnvironmentVariable = typeof ProviderInstanceEnvironmentVariable.Type;

export const ProviderInstanceEnvironment = Schema.Array(ProviderInstanceEnvironmentVariable);
export type ProviderInstanceEnvironment = typeof ProviderInstanceEnvironment.Type;

/**
 * The driver-specific config payload is left as `Schema.Unknown`; each driver
 * registers its own decoder with the runtime registry, and envelopes for
 * unknown drivers are preserved verbatim so they round-trip across version
 * changes without data loss.
 */
export const ProviderInstanceConfig = Schema.Struct({
  driver: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  accentColor: Schema.optional(TrimmedNonEmptyString),
  environment: Schema.optionalKey(ProviderInstanceEnvironment),
  enabled: Schema.optionalKey(Schema.Boolean),
  config: Schema.optionalKey(Schema.Unknown),
});
export type ProviderInstanceConfig = typeof ProviderInstanceConfig.Type;

export const ProviderInstanceMutation = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("create"),
    instanceId: ProviderInstanceId,
    instance: ProviderInstanceConfig,
  }),
  Schema.Struct({
    operation: Schema.Literal("upsert"),
    instanceId: ProviderInstanceId,
    instance: ProviderInstanceConfig,
  }),
  Schema.Struct({
    operation: Schema.Literal("remove"),
    instanceId: ProviderInstanceId,
  }),
]);
export type ProviderInstanceMutation = typeof ProviderInstanceMutation.Type;

export const ProviderInstanceConfigMap = Schema.Record(ProviderInstanceId, ProviderInstanceConfig);
export type ProviderInstanceConfigMap = typeof ProviderInstanceConfigMap.Type;

/**
 * The legacy single-instance-per-driver world used the driver kind itself as
 * the instance id; preserving that mapping keeps existing persisted threads,
 * bindings, and cache files routable across the migration without rewriting
 * their stored selection payloads.
 */
export const defaultInstanceIdForDriver = (driver: ProviderDriverKind): ProviderInstanceId =>
  ProviderInstanceId.make(driver);
