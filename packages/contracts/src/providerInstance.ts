import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SecretReference } from "./secretReference.ts";

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

export const isProviderDriverKind = Schema.is(ProviderDriverKind);

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

const ProviderInstanceEnvironmentVariableValue = Schema.Struct({
  name: ProviderInstanceEnvironmentVariableName,
  value: Schema.Union([Schema.String, SecretReference]),
  sensitive: Schema.Boolean,
  valueRedacted: Schema.optionalKey(Schema.Boolean),
});

// A reference is encoded beside an empty value so older servers and clients still decode it.
const StoredProviderInstanceEnvironmentVariable = Schema.Struct({
  name: ProviderInstanceEnvironmentVariableName,
  value: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  sensitive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  valueRedacted: Schema.optionalKey(Schema.Boolean),
  secret: Schema.optionalKey(SecretReference),
});

export const ProviderInstanceEnvironmentVariable = StoredProviderInstanceEnvironmentVariable.pipe(
  Schema.decodeTo(
    Schema.toType(ProviderInstanceEnvironmentVariableValue),
    SchemaTransformation.transform<
      typeof ProviderInstanceEnvironmentVariableValue.Type,
      typeof StoredProviderInstanceEnvironmentVariable.Type
    >({
      decode: ({ secret, ...variable }) =>
        secret === undefined ? variable : { ...variable, value: secret, sensitive: true },
      encode: ({ value, ...variable }) =>
        typeof value === "string"
          ? { ...variable, value }
          : { ...variable, value: "", secret: value },
    }),
  ),
);
export type ProviderInstanceEnvironmentVariable = typeof ProviderInstanceEnvironmentVariable.Type;

export const ProviderInstanceEnvironment = Schema.Array(ProviderInstanceEnvironmentVariable);
export type ProviderInstanceEnvironment = typeof ProviderInstanceEnvironment.Type;

/** What drivers receive: every secret reference has been read into a plain value. */
export type ResolvedProviderInstanceEnvironment = ReadonlyArray<
  Omit<ProviderInstanceEnvironmentVariable, "value"> & { readonly value: string }
>;

/** Drivers decode their own config; unknown-driver envelopes round-trip verbatim across versions. */
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

/** Driver-kind ids keep stored selections routable without migration. */
export const defaultInstanceIdForDriver = (driver: ProviderDriverKind): ProviderInstanceId =>
  ProviderInstanceId.make(driver);
