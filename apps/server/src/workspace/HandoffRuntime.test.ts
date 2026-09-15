import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { renderHandoffRuntimeObservation } from "@t3tools/shared/contextHandoff";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Cause from "effect/Cause";
import * as TestClock from "effect/testing/TestClock";
import {
  makeHandoffRuntimeObserver,
  makeRuntimeObserver,
  type RuntimeObservationPorts,
} from "./HandoffRuntime.ts";

const bootId = "12345678-1234-1234-1234-123456789abc";
const profiles = {
  running: `/nix/store/${"a".repeat(32)}-nixos-system-test-running`,
  booted: `/nix/store/${"b".repeat(32)}-nixos-system-test-booted`,
  nextBoot: `/nix/store/${"c".repeat(32)}-nixos-system-test-next`,
};
const ports: RuntimeObservationPorts = {
  backend: Effect.succeed({
    pid: 123,
    nodeVersion: "v22.0.0",
    packageVersion: "1.2.3",
    platform: "linux",
    architecture: "x64",
    uptimeSeconds: 12,
  }),
  readBootId: Effect.succeed(bootId),
  resolveSystem: (profile) => Effect.succeed(profiles[profile]),
};

it.effect("keeps collecting backend metadata and three different system profiles distinct", () =>
  Effect.gen(function* () {
    const result = yield* makeRuntimeObserver(ports)();
    assert.strictEqual(result.state, "observed");
    if (result.state !== "observed") return;
    assert.strictEqual(result.backend.pid, 123);
    assert.strictEqual(result.backend.packageVersion, "1.2.3");
    assert.strictEqual(result.sourceRevision, "unknown");
    assert.deepEqual(result.bootId, { state: "observed", value: bootId });
    for (const key of ["running", "booted", "nextBoot"] as const)
      assert.deepEqual(result.nixos[key], { state: "observed", value: profiles[key] });
    const text = renderHandoffRuntimeObservation(result);
    assert.include(text, "Current validity is unknown");
    assert.include(text, "exact source revision is unknown");
    assert.include(text, "no execution authority");
  }),
);
it.effect("reports malformed and missing values independently", () =>
  Effect.gen(function* () {
    const result = yield* makeRuntimeObserver({
      ...ports,
      readBootId: Effect.succeed("bad"),
      resolveSystem: (profile) =>
        profile === "booted"
          ? Effect.fail("not_found" as const)
          : Effect.succeed("/not/a/nixos-profile"),
    })();
    assert.strictEqual(result.state, "observed");
    if (result.state !== "observed") return;
    assert.deepEqual(result.bootId, { state: "unavailable", code: "malformed" });
    assert.deepEqual(result.nixos.booted, { state: "unavailable", code: "not_found" });
    assert.deepEqual(result.nixos.running, { state: "unavailable", code: "malformed" });
  }),
);
it.effect("skips Linux filesystem probes on unsupported platforms", () =>
  Effect.gen(function* () {
    const result = yield* makeRuntimeObserver({
      ...ports,
      backend: ports.backend.pipe(Effect.map((backend) => ({ ...backend, platform: "darwin" }))),
      readBootId: Effect.die("must not read"),
      resolveSystem: () => Effect.die("must not resolve"),
    })();
    assert.strictEqual(result.state, "observed");
    if (result.state === "observed") {
      assert.deepEqual(result.bootId, { state: "unavailable", code: "unsupported_platform" });
      assert.deepEqual(result.nixos.nextBoot, {
        state: "unavailable",
        code: "unsupported_platform",
      });
    }
  }),
);
it.effect("does not present a changing profile as a stable observation", () =>
  Effect.gen(function* () {
    let reads = 0;
    const result = yield* makeRuntimeObserver({
      ...ports,
      resolveSystem: () => Effect.sync(() => (++reads % 2 ? profiles.running : profiles.nextBoot)),
    })();
    assert.strictEqual(result.state, "observed");
    if (result.state === "observed")
      assert.deepEqual(result.nixos.running, {
        state: "unavailable",
        code: "changed_during_observation",
      });
  }),
);
it.effect("bounds hung reads and preserves cancellation", () =>
  Effect.gen(function* () {
    const observe = makeRuntimeObserver({ ...ports, readBootId: Effect.never });
    const fiber = yield* observe().pipe(Effect.forkChild);
    yield* TestClock.adjust("2 seconds");
    const result = yield* Fiber.join(fiber);
    assert.strictEqual(result.state, "unavailable");
    if (result.state === "unavailable") assert.strictEqual(result.code, "timed_out");
    const cancelled = yield* observe().pipe(Effect.forkChild);
    yield* Fiber.interrupt(cancelled);
    const exit = yield* Fiber.await(cancelled);
    assert.strictEqual(exit._tag, "Failure");
    if (exit._tag === "Failure") assert.isTrue(Cause.hasInterruptsOnly(exit.cause));
  }),
);
it.layer(NodeServices.layer)("runtime filesystem adapter", (it) => {
  it.effect(
    "reads only the fixed paths, handles proc-sized files and rejects oversized boot IDs",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const fixture = `${root}/boot-id`;
        yield* fs.writeFileString(fixture, `${bootId}\n`);
        const paths: string[] = [];
        const fake = FileSystem.FileSystem.of({
          ...fs,
          open: (path, options) => {
            paths.push(path);
            return fs.open(fixture, options);
          },
          realPath: (path) => {
            paths.push(path);
            return Effect.succeed(profiles.running);
          },
        });
        const observe = yield* makeHandoffRuntimeObserver.pipe(
          Effect.provideService(FileSystem.FileSystem, fake),
          Effect.provideService(HostProcessPlatform, "linux"),
        );
        const first = yield* observe();
        assert.strictEqual(first.state, "observed");
        if (first.state === "observed")
          assert.deepEqual(first.bootId, { state: "observed", value: bootId });
        assert.deepEqual(
          [...new Set(paths)].sort(),
          [
            "/proc/sys/kernel/random/boot_id",
            "/run/current-system",
            "/run/booted-system",
            "/nix/var/nix/profiles/system",
          ].sort(),
        );
        yield* fs.writeFileString(fixture, "x".repeat(10_000));
        const oversized = yield* observe();
        assert.strictEqual(oversized.state, "observed");
        if (oversized.state === "observed")
          assert.deepEqual(oversized.bootId, { state: "unavailable", code: "malformed" });
      }),
  );
});
