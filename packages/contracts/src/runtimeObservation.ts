import * as Schema from "effect/Schema";
import { IsoDateTime, PositiveInt } from "./baseSchemas.ts";

export const RuntimeObservationUnavailable = Schema.Struct({
  state: Schema.Literal("unavailable"),
  code: Schema.Literals([
    "not_found",
    "unsupported_platform",
    "read_failed",
    "malformed",
    "changed_during_observation",
    "timed_out",
  ]),
});
const BootId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/),
);
const NixSystemPath = Schema.String.check(
  Schema.isMaxLength(512),
  Schema.isPattern(/^\/nix\/store\/[a-z0-9]{32}-nixos-system-[^/\r\n]+$/),
);
export const RuntimeBootId = Schema.Union([
  Schema.Struct({ state: Schema.Literal("observed"), value: BootId }),
  RuntimeObservationUnavailable,
]);
export const RuntimeSystemPath = Schema.Union([
  Schema.Struct({ state: Schema.Literal("observed"), value: NixSystemPath }),
  RuntimeObservationUnavailable,
]);
export const HandoffRuntimeObservation = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    state: Schema.Literal("observed"),
    collectedAt: IsoDateTime,
    backend: Schema.Struct({
      pid: PositiveInt,
      nodeVersion: Schema.String.check(Schema.isMaxLength(128)),
      packageVersion: Schema.String.check(Schema.isMaxLength(128)),
      platform: Schema.String.check(Schema.isMaxLength(32)),
      architecture: Schema.String.check(Schema.isMaxLength(32)),
      uptimeSeconds: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
    sourceRevision: Schema.Literal("unknown"),
    bootId: RuntimeBootId,
    nixos: Schema.Struct({
      running: RuntimeSystemPath,
      booted: RuntimeSystemPath,
      nextBoot: RuntimeSystemPath,
    }),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    state: Schema.Literal("unavailable"),
    collectedAt: IsoDateTime,
    code: Schema.Literals(["read_failed", "timed_out"]),
  }),
]);
export type HandoffRuntimeObservation = typeof HandoffRuntimeObservation.Type;
