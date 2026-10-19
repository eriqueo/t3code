import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  REVIEW_PROVIDER_INSTANCE_ID,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ProviderDriverError } from "./Errors.ts";
import type {
  ProviderDriver,
  ProviderDriverCreateInput,
} from "@t3tools/provider-core/server/driver";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";

describe("reserved Review instance admission", () => {
  const reservedId = ProviderInstanceId.make(REVIEW_PROVIDER_INSTANCE_ID);
  const cases: ReadonlyArray<{
    driver: string;
    enabled?: boolean;
    config?: unknown;
  }> = [
    { driver: "codex", enabled: true },
    { driver: "codex", enabled: false },
    { driver: "codex" },
    { driver: "claudeAgent", enabled: true },
    { driver: "claudeAgent", enabled: false },
    { driver: "fork_driver", enabled: true },
    { driver: "unknown_driver", enabled: true },
    {
      driver: "codex",
      enabled: true,
      config: { binaryPath: "/untrusted/codex", homePath: "/untrusted/home", launchArgs: "--yolo" },
    },
  ];

  const sentinelDrivers = (calls: Array<string>) =>
    ["codex", "claudeAgent", "fork_driver"].map((name): ProviderDriver<unknown, never> => ({
      driverKind: ProviderDriverKind.make(name),
      metadata: { displayName: name },
      configSchema: Schema.Unknown,
      defaultConfig: () => ({}),
      create: ({ instanceId }) =>
        Effect.suspend(() => {
          calls.push(instanceId);
          return Effect.fail(
            new ProviderDriverError({
              driver: ProviderDriverKind.make(name),
              instanceId,
              detail: "Sentinel: no filesystem or process effects.",
            }),
          );
        }),
    }));

  const scopedDriver = (
    role: string,
    calls: Array<ProviderDriverCreateInput<unknown>>,
    lifecycle: Array<string>,
  ): ProviderDriver<unknown> => ({
    driverKind: ProviderDriverKind.make("codex"),
    metadata: { displayName: role },
    configSchema: Schema.Unknown,
    defaultConfig: () => ({}),
    create: (input) =>
      Effect.gen(function* () {
        calls.push(input);
        const identity = `${role}:${calls.length}`;
        lifecycle.push(`create:${identity}`);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            lifecycle.push(`release:${identity}`);
          }),
        );
        return {
          instanceId: input.instanceId,
          driverKind: ProviderDriverKind.make("codex"),
          continuationIdentity: {
            driverKind: ProviderDriverKind.make("codex"),
            continuationKey: identity,
          },
          displayName: input.displayName,
          enabled: input.enabled,
          get orchestrationAdapter(): never {
            throw new Error("Registry fixture must not start a session.");
          },
          get snapshot(): never {
            throw new Error("Registry fixture must not probe a provider.");
          },
          get textGeneration(): never {
            throw new Error("Registry fixture must not generate text.");
          },
        };
      }),
  });

  it.effect(
    "synthesizes Review only through its trusted port and preserves ordinary instances",
    () =>
      Effect.gen(function* () {
        const ordinaryCalls: Array<ProviderDriverCreateInput<unknown>> = [];
        const reviewCalls: Array<ProviderDriverCreateInput<unknown>> = [];
        const lifecycle: string[] = [];
        const personalId = ProviderInstanceId.make("codex_personal");
        const settings: ProviderInstanceConfigMap = {
          [personalId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
        };
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { registry, mutator } = yield* makeProviderInstanceRegistry({
              drivers: [scopedDriver("ordinary", ordinaryCalls, lifecycle)],
              reviewDriver: scopedDriver("trusted", reviewCalls, lifecycle),
              configMap: settings,
            });
            const first = yield* registry.getInstance(reservedId);
            expect(first?.continuationIdentity.continuationKey).toBe("trusted:1");
            expect(first?.displayName).toBe("Review");
            expect(first?.enabled).toBe(true);
            expect(ordinaryCalls.map((input) => input.instanceId)).toEqual([personalId]);
            expect(reviewCalls).toEqual([
              {
                instanceId: reservedId,
                displayName: "Review",
                accentColor: undefined,
                environment: [],
                enabled: true,
                config: {},
              },
            ]);
            yield* mutator.reconcile({ ...settings });
            expect(yield* registry.getInstance(reservedId)).toBe(first);
            expect(reviewCalls).toHaveLength(1);
            expect(ordinaryCalls).toHaveLength(1);
            expect(yield* registry.listUnavailable).toEqual([]);
            expect(lifecycle).toEqual(["create:ordinary:1", "create:trusted:1"]);
          }),
        );
        expect(lifecycle.filter((event) => event.startsWith("release:")).toSorted()).toEqual([
          "release:ordinary:1",
          "release:trusted:1",
        ]);
      }),
  );

  it.effect("refuses settings-owned Review even when a trusted driver is supplied", () =>
    Effect.gen(function* () {
      for (const entry of [
        {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          displayName: "Review",
          config: {},
        },
        ...cases.map((entry) => ({ ...entry, driver: ProviderDriverKind.make(entry.driver) })),
      ]) {
        const ordinaryCalls: Array<ProviderDriverCreateInput<unknown>> = [];
        const reviewCalls: Array<ProviderDriverCreateInput<unknown>> = [];
        const lifecycle: string[] = [];
        const { registry } = yield* makeProviderInstanceRegistry({
          drivers: [scopedDriver("ordinary", ordinaryCalls, lifecycle)],
          reviewDriver: scopedDriver("trusted", reviewCalls, lifecycle),
          configMap: { [reservedId]: entry },
        });
        expect(ordinaryCalls).toEqual([]);
        expect(reviewCalls).toEqual([]);
        expect(lifecycle).toEqual([]);
        expect(yield* registry.getInstance(reservedId)).toBeUndefined();
        expect(yield* registry.listUnavailable).toMatchObject([
          { instanceId: reservedId, displayName: "Review", availability: "unavailable" },
        ]);
      }
    }).pipe(Effect.scoped),
  );

  it.effect(
    "tears down trusted Review on an equal forged entry and rebuilds after its removal",
    () =>
      Effect.gen(function* () {
        const ordinaryCalls: Array<ProviderDriverCreateInput<unknown>> = [];
        const reviewCalls: Array<ProviderDriverCreateInput<unknown>> = [];
        const lifecycle: string[] = [];
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { registry, mutator } = yield* makeProviderInstanceRegistry({
              drivers: [scopedDriver("ordinary", ordinaryCalls, lifecycle)],
              reviewDriver: scopedDriver("trusted", reviewCalls, lifecycle),
              configMap: {},
            });
            const first = yield* registry.getInstance(reservedId);
            expect(first).toBeDefined();
            // Every setting equals the synthetic envelope; provenance must invalidate it.
            yield* mutator.reconcile({
              [reservedId]: {
                driver: ProviderDriverKind.make("codex"),
                enabled: true,
                displayName: "Review",
                config: {},
              },
            });
            expect(lifecycle).toEqual(["create:trusted:1", "release:trusted:1"]);
            expect(yield* registry.getInstance(reservedId)).toBeUndefined();
            expect(yield* registry.listInstances).toEqual([]);
            expect(yield* registry.listUnavailable).toMatchObject([
              { instanceId: reservedId, availability: "unavailable" },
            ]);
            expect(reviewCalls).toHaveLength(1);
            expect(ordinaryCalls).toEqual([]);

            yield* mutator.reconcile({});
            const replacement = yield* registry.getInstance(reservedId);
            expect(replacement).toBeDefined();
            expect(replacement === first).toBe(false);
            expect(replacement?.continuationIdentity.continuationKey).toBe("trusted:2");
            expect(yield* registry.listUnavailable).toEqual([]);
            expect(lifecycle).toEqual([
              "create:trusted:1",
              "release:trusted:1",
              "create:trusted:2",
            ]);
            expect(ordinaryCalls).toEqual([]);
          }),
        );
        expect(lifecycle).toEqual([
          "create:trusted:1",
          "release:trusted:1",
          "create:trusted:2",
          "release:trusted:2",
        ]);
      }),
  );

  it.effect.each(["initial", "reconcile"] as const)(
    "rejects reserved Review before driver creation during %s admission",
    (admission) =>
      Effect.gen(function* () {
        for (const entry of cases) {
          const calls: Array<string> = [];
          const configMap: ProviderInstanceConfigMap = {
            [reservedId]: {
              ...entry,
              driver: ProviderDriverKind.make(entry.driver),
              displayName: "Misleading development profile",
              environment: [
                { name: "T3CODE_CODEX_LAUNCH_ARGS", value: "--yolo", sensitive: false },
              ],
            },
          };
          const { registry, mutator } = yield* makeProviderInstanceRegistry({
            drivers: sentinelDrivers(calls),
            configMap: admission === "initial" ? configMap : {},
          });
          if (admission === "reconcile") yield* mutator.reconcile(configMap);
          expect(calls).toEqual([]);
          expect(yield* registry.getInstance(reservedId)).toBeUndefined();
          expect(yield* registry.listInstances).toEqual([]);
          expect(yield* registry.listUnavailable).toMatchObject([
            { instanceId: "codex_review", displayName: "Review", availability: "unavailable" },
          ]);
        }
      }).pipe(Effect.scoped),
  );

  it.effect("still calls a driver for an ordinary development identity", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      yield* makeProviderInstanceRegistry({
        drivers: sentinelDrivers(calls),
        configMap: {
          [ProviderInstanceId.make("codex_personal")]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: false,
          },
        },
      });
      expect(calls).toEqual(["codex_personal"]);
    }).pipe(Effect.scoped),
  );
});
