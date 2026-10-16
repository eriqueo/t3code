import {
  CodexSettings,
  ProviderDriverKind,
  REVIEW_PROVIDER_INSTANCE_ID,
  TextGenerationError,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { ChildProcessSpawner } from "effect/unstable/process";

import type { ServerConfig } from "../../config.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeCodexAdapter } from "../Layers/CodexAdapter.ts";
import { makeCodexReviewRuntimeLauncher } from "../Layers/CodexReviewRuntime.ts";
import {
  CODEX_REVIEW_MODEL,
  CODEX_REVIEW_NATIVE_VERSION,
  type CodexReviewLaunchConfig,
} from "../Layers/codexReviewPolicy.ts";
import type { ProviderDriver, ProviderInstance } from "../ProviderDriver.ts";
import { buildServerProvider } from "../providerSnapshot.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const DRIVER_KIND = ProviderDriverKind.make("codex");
const reviewConfig = Schema.Struct({});
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

type ReviewDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig;

/** Server-owned only: never register this factory in the settings-selected driver list. */
export const makeCodexReviewDriver = (
  launch: CodexReviewLaunchConfig,
): ProviderDriver<typeof reviewConfig.Type, ReviewDriverEnv> => ({
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Review", supportsMultipleInstances: false },
  configSchema: reviewConfig,
  defaultConfig: () => ({}),
  create: ({ instanceId, environment, enabled }) =>
    Effect.gen(function* () {
      if (instanceId !== REVIEW_PROVIDER_INSTANCE_ID || environment.length > 0 || !enabled) {
        return yield* new ProviderDriverError({
          driver: DRIVER_KIND,
          instanceId,
          detail: "Review requires its server-owned configuration.",
        });
      }
      const makeRuntime = yield* makeCodexReviewRuntimeLauncher(launch);
      const ordinaryAdapter = yield* makeCodexAdapter(
        decodeCodexSettings({ enabled: true, binaryPath: "controlled-review", launchArgs: "" }),
        { instanceId, readOnly: true, environment: {}, makeRuntime },
      );
      const {
        compaction: _compaction,
        uploadFeedback: _uploadFeedback,
        ...adapter
      } = ordinaryAdapter;
      const continuationIdentity = {
        driverKind: DRIVER_KIND,
        continuationKey: "codex:review:ephemeral",
      };
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      const snapshot = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName: "Review",
        accentColor: undefined,
        continuationGroupKey: continuationIdentity.continuationKey,
      })(
        buildServerProvider({
          presentation: {
            displayName: "Review",
            supportsConversationRollback: false,
            showInteractionModeToggle: false,
            requiresNewThreadForModelChange: true,
          },
          enabled: true,
          checkedAt,
          models: [
            {
              slug: CODEX_REVIEW_MODEL,
              name: CODEX_REVIEW_MODEL,
              isCustom: false,
              isDefault: true,
              capabilities: null,
            },
          ],
          probe: {
            installed: true,
            version: CODEX_REVIEW_NATIVE_VERSION,
            status: "ready",
            auth: { status: "unknown" },
            message: "Review checks the native isolation policy before each session and turn.",
          },
        }),
      );
      const noGeneration = (operation: string) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "Review cannot run background generation.",
          }),
        );
      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName: "Review",
        enabled: true,
        snapshot: {
          resolveMaintenance: () =>
            Effect.succeed({ provider: DRIVER_KIND, packageName: null, update: null }),
          getSnapshot: Effect.succeed(snapshot),
          refresh: Effect.succeed(snapshot),
          streamChanges: Stream.empty,
          applyUsageLimits: () => Effect.void,
        },
        adapter: {
          ...adapter,
          capabilities: { sessionModelSwitch: "unsupported", supportsConversationRollback: false },
        },
        textGeneration: {
          generateCommitMessage: () => noGeneration("generateCommitMessage"),
          generatePrContent: () => noGeneration("generatePrContent"),
          generateBranchName: () => noGeneration("generateBranchName"),
          generateThreadTitle: () => noGeneration("generateThreadTitle"),
        },
      } satisfies ProviderInstance;
    }),
});
