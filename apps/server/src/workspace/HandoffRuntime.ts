import {
  HandoffRuntimeObservation,
  RuntimeBootId,
  RuntimeSystemPath,
  type RuntimeObservationUnavailable,
} from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import packageJson from "../../package.json" with { type: "json" };

type Unavailable = typeof RuntimeObservationUnavailable.Type;
const decodeBoot = Schema.decodeUnknownEffect(RuntimeBootId);
const decodeSystem = Schema.decodeUnknownEffect(RuntimeSystemPath);
const decodeObservation = Schema.decodeUnknownEffect(HandoffRuntimeObservation);
type Backend = Extract<HandoffRuntimeObservation, { state: "observed" }>["backend"];
export interface RuntimeObservationPorts {
  readonly backend: Effect.Effect<Backend>;
  readonly readBootId: Effect.Effect<string, Unavailable["code"]>;
  readonly resolveSystem: (
    profile: "running" | "booted" | "nextBoot",
  ) => Effect.Effect<string, Unavailable["code"]>;
}

// All mutable inputs come through the adapter. No process runner, environment
// dump, source checkout, or persisted runtime-file PID participates in this read.
export const makeRuntimeObserver = (ports: RuntimeObservationPorts) =>
  Effect.fn("HandoffRuntime.observe")(function* () {
    const collectedAt = DateTime.formatIso(yield* DateTime.now);
    const unavailable = (code: Unavailable["code"]): Unavailable => ({
      state: "unavailable",
      code,
    });
    const stable = Effect.fnUntraced(function* (read: Effect.Effect<string, Unavailable["code"]>) {
      const first = yield* read;
      const second = yield* read;
      if (first !== second) return yield* Effect.fail("changed_during_observation" as const);
      return first;
    });
    const collect = Effect.gen(function* () {
      const backend = yield* ports.backend;
      const bootId =
        backend.platform !== "linux"
          ? unavailable("unsupported_platform")
          : yield* stable(ports.readBootId).pipe(
              Effect.flatMap((value) =>
                decodeBoot({ state: "observed", value }).pipe(
                  Effect.mapError(() => "malformed" as const),
                ),
              ),
              Effect.catch((code) => Effect.succeed(unavailable(code))),
            );
      const system = (profile: "running" | "booted" | "nextBoot") =>
        backend.platform !== "linux"
          ? Effect.succeed(unavailable("unsupported_platform"))
          : stable(ports.resolveSystem(profile)).pipe(
              Effect.flatMap((value) =>
                decodeSystem({ state: "observed", value }).pipe(
                  Effect.mapError(() => "malformed" as const),
                ),
              ),
              Effect.catch((code) => Effect.succeed(unavailable(code))),
            );
      return yield* decodeObservation({
        version: 1,
        state: "observed",
        collectedAt,
        backend,
        sourceRevision: "unknown",
        bootId,
        nixos: {
          running: yield* system("running"),
          booted: yield* system("booted"),
          nextBoot: yield* system("nextBoot"),
        },
      });
    });
    const result = yield* collect.pipe(
      Effect.catch(() =>
        Effect.succeed({
          version: 1,
          state: "unavailable",
          collectedAt,
          code: "read_failed",
        } satisfies HandoffRuntimeObservation),
      ),
      Effect.timeoutOption("2 seconds"),
    );
    return Option.isSome(result)
      ? result.value
      : ({
          version: 1,
          state: "unavailable",
          collectedAt,
          code: "timed_out",
        } satisfies HandoffRuntimeObservation);
  });

const SYSTEM_PROFILES = {
  running: "/run/current-system",
  booted: "/run/booted-system",
  nextBoot: "/nix/var/nix/profiles/system",
} as const;
export const makeHandoffRuntimeObserver = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  const readBootId = Effect.gen(function* () {
    const file = yield* fs.open("/proc/sys/kernel/random/boot_id", { flag: "r" });
    const chunks: number[] = [];
    while (true) {
      const chunk = yield* file.readAlloc(4097 - chunks.length);
      if (Option.isNone(chunk)) break;
      chunks.push(...chunk.value);
      if (chunks.length > 4096) return yield* Effect.fail("malformed" as const);
    }
    return new TextDecoder().decode(Uint8Array.from(chunks)).trim();
  }).pipe(
    Effect.scoped,
    Effect.catch((error) =>
      Effect.fail(
        typeof error === "string"
          ? error
          : error.reason._tag === "NotFound"
            ? ("not_found" as const)
            : ("read_failed" as const),
      ),
    ),
  );
  return makeRuntimeObserver({
    backend: Effect.sync(() => ({
      pid: process.pid,
      nodeVersion: process.version,
      packageVersion: packageJson.version,
      platform,
      architecture,
      uptimeSeconds: process.uptime(),
    })),
    readBootId,
    resolveSystem: (profile) =>
      fs
        .realPath(SYSTEM_PROFILES[profile])
        .pipe(
          Effect.mapError((error) =>
            error.reason._tag === "NotFound" ? ("not_found" as const) : ("read_failed" as const),
          ),
        ),
  });
});
