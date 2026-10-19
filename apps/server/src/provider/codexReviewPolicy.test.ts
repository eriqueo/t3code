// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { it as effectIt } from "@effect/vitest";
import { makeReviewRequest } from "./CodexReviewRuntime.ts";
import { describe, it } from "vite-plus/test";

import {
  CodexReviewLaunchConfig,
  ReviewRequirements,
  reviewEffectiveConfigSchema,
  reviewLaunchSpec,
  reviewThreadReceiptSchema,
} from "./codexReviewPolicy.ts";

const workspace = "/tmp/t3-review-fixture";
const homePath = `${workspace}/home/codex`;
const neutral = `${workspace}/neutral`;
const decodeRequirements = Schema.decodeUnknownSync(ReviewRequirements);

// Sanitized 0.163 response shape. Extra ordinary fields reflect the native
// response; the required containment values are independently specified here.
const effectiveConfig = {
  config: {
    model: "gpt-6.1-sol",
    model_reasoning_effort: "high",
    approval_policy: "never",
    sandbox_mode: "read-only",
    web_search: "disabled",
    cli_auth_credentials_store: "file",
    allow_login_shell: false,
    model_provider: "openai",
    default_permissions: null,
    permissions: null,
    profile: null,
    profiles: {},
    mcp_servers: {},
    agents: { enabled: false },
    apps: { _default: { enabled: false } },
    features: {
      apps: false,
      multi_agent: false,
      multi_agent_v2: false,
      plugins: false,
      remote_plugin: false,
      hooks: false,
      browser_use: false,
      browser_use_external: false,
      browser_use_full_cdp_access: false,
      computer_use: false,
      in_app_browser: false,
      in_app_local_automation: false,
      in_app_chat: false,
      code_mode: false,
      code_mode_host: true,
      image_generation: false,
      skill_mcp_dependency_install: false,
      skill_search: false,
    },
  },
  layers: [
    { name: { type: "system", file: "/etc/codex/config.toml" }, disabledReason: null },
    { name: { type: "user", file: `${homePath}/config.toml` }, disabledReason: null },
    { name: { type: "sessionFlags" }, disabledReason: null },
  ],
};

const threadReceipt = {
  cwd: neutral,
  model: "gpt-6.1-sol",
  modelProvider: "openai",
  approvalPolicy: "never",
  approvalsReviewer: "user",
  sandbox: { type: "readOnly", networkAccess: false },
  activePermissionProfile: null,
  runtimeWorkspaceRoots: [neutral],
  instructionSources: [],
  thread: {
    id: "sanitized-review-native-thread",
    status: { type: "idle" },
    environments: [{ environmentId: "local", cwd: neutral, runtimeWorkspaceRoots: [neutral] }],
  },
};

const launchConfig = {
  nativeDirectory: "/nix/store/00000000000000000000000000000000-codex-native-0.163.0",
  pythonPath: "/nix/store/11111111111111111111111111111111-python3/bin/python3",
  mountPath: "/nix/store/22222222222222222222222222222222-util-linux/bin/mount",
  unsharePath: "/nix/store/22222222222222222222222222222222-util-linux/bin/unshare",
  authSource: "/home/fixture/.codex/auth.json",
  path: "/nix/store/33333333333333333333333333333333-review-tools/bin",
};

describe("Review V2 native request boundary", () => {
  const fixture = (config = effectiveConfig, receipt: unknown = threadReceipt) => {
    const calls: Array<{ method: string; payload: unknown }> = [];
    let closed = false;
    const request = makeReviewRequest({
      homePath,
      cwd: neutral,
      close: Effect.sync(() => {
        closed = true;
      }),
      request: (method, payload) =>
        Effect.sync(() => {
          calls.push({ method, payload });
          if (method === "configRequirements/read") return { requirements: null };
          if (method === "config/read") return config;
          if (method === "thread/start") return receipt;
          return { turn: { id: "turn" } };
        }),
    });
    return { request, calls, closed: () => closed };
  };
  effectIt.effect("pins thread and turn permissions and omits injected MCP/configuration", () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* f.request("thread/start", {
        model: "gpt-6.1-sol",
        cwd: "/host",
        config: { mcp_servers: { unsafe: { token: "fixture" } } },
      });
      NodeAssert.deepEqual(f.calls.find((call) => call.method === "thread/start")!.payload, {
        cwd: neutral,
        model: "gpt-6.1-sol",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: "read-only",
        runtimeWorkspaceRoots: [neutral],
        selectedCapabilityRoots: [],
        dynamicTools: [],
      });
      yield* f.request("turn/start", {
        threadId: threadReceipt.thread.id,
        input: [{ type: "text", text: "Review" }],
        model: "gpt-6.1-sol",
        sandboxPolicy: { type: "dangerFullAccess" },
        config: { unsafe: true },
      });
      const turn = f.calls.at(-1)!.payload as Record<string, unknown>;
      NodeAssert.deepEqual(turn.sandboxPolicy, { type: "readOnly", networkAccess: false });
      NodeAssert.equal(turn.cwd, neutral);
      NodeAssert.equal(turn.approvalPolicy, "never");
      NodeAssert.equal("config" in turn, false);
      NodeAssert.equal(
        f.calls.filter((call) => call.method === "configRequirements/read").length,
        2,
      );
      NodeAssert.equal(f.closed(), false);
    }),
  );
  effectIt.effect.each([
    "thread/resume",
    "thread/fork",
    "thread/rollback",
    "thread/compact/start",
    "feedback/upload",
    "config/value/write",
    "command/exec",
  ])("rejects %s before native effects and closes the owned runtime", (method) =>
    Effect.gen(function* () {
      const f = fixture();
      NodeAssert.equal((yield* Effect.result(f.request(method, {})))._tag, "Failure");
      NodeAssert.equal(f.calls.length, 0);
      NodeAssert.equal(f.closed(), true);
    }),
  );
  effectIt.effect("refuses unverified policy before thread creation", () =>
    Effect.gen(function* () {
      const config = structuredClone(effectiveConfig);
      config.config.sandbox_mode = "workspace-write";
      const f = fixture(config);
      NodeAssert.equal((yield* Effect.result(f.request("thread/start", {})))._tag, "Failure");
      NodeAssert.equal(
        f.calls.some((call) => call.method === "thread/start"),
        false,
      );
      NodeAssert.equal(f.closed(), true);
    }),
  );
  effectIt.effect("rechecks configuration before a subsequent turn", () =>
    Effect.gen(function* () {
      const config = structuredClone(effectiveConfig);
      const f = fixture(config);
      yield* f.request("thread/start", {});
      config.config.web_search = "live";
      NodeAssert.equal(
        (yield* Effect.result(
          f.request("turn/start", {
            threadId: threadReceipt.thread.id,
            input: [],
          }),
        ))._tag,
        "Failure",
      );
      NodeAssert.equal(
        f.calls.some((call) => call.method === "turn/start"),
        false,
      );
      NodeAssert.equal(f.closed(), true);
    }),
  );
  effectIt.effect("refuses an unverified native thread receipt and closes", () =>
    Effect.gen(function* () {
      const f = fixture(effectiveConfig, { ...threadReceipt, sandbox: { type: "workspaceWrite" } });
      NodeAssert.equal((yield* Effect.result(f.request("thread/start", {})))._tag, "Failure");
      NodeAssert.equal(f.closed(), true);
    }),
  );
  effectIt.effect.each([{ model: "other-model" }, { threadId: "foreign" }])(
    "rejects a changed model or foreign native thread: %j",
    (overrides) =>
      Effect.gen(function* () {
        const f = fixture();
        yield* f.request("thread/start", {});
        NodeAssert.equal(
          (yield* Effect.result(
            f.request("turn/start", {
              threadId: threadReceipt.thread.id,
              input: [],
              ...overrides,
            }),
          ))._tag,
          "Failure",
        );
        NodeAssert.equal(
          f.calls.some((call) => call.method === "turn/start"),
          false,
        );
      }),
  );
});

describe("Review effective native configuration", () => {
  const decode = Schema.decodeUnknownSync(reviewEffectiveConfigSchema(homePath));

  it("accepts the sanitized 0.163 configuration and no managed requirements", () => {
    NodeAssert.doesNotThrow(() => decode(effectiveConfig));
    NodeAssert.deepEqual(decodeRequirements({ requirements: null }), {
      requirements: null,
    });
  });

  it.each(Object.keys(effectiveConfig.config.features).map((value) => [value] as const))(
    "rejects changing required feature %j",
    (feature) => {
      const value = structuredClone(effectiveConfig);
      const key = feature as keyof typeof value.config.features;
      value.config.features[key] = !value.config.features[key];
      NodeAssert.throws(() => decode(value));
    },
  );

  it("requires the isolated code_mode_host while keeping ordinary code_mode disabled", () => {
    const decoded = decode(effectiveConfig);
    NodeAssert.equal(decoded.config.features.code_mode_host, true);
    NodeAssert.equal(decoded.config.features.code_mode, false);
    const missingHost = structuredClone(effectiveConfig) as Record<string, unknown>;
    const config = missingHost.config as { features: Record<string, unknown> };
    delete config.features.code_mode_host;
    NodeAssert.throws(() => decode(missingHost));
  });

  it.each(
    Object.keys(effectiveConfig.config)
      .filter((control) => control !== "model" && control !== "model_reasoning_effort")
      .map((value) => [value] as const),
  )("rejects missing containment control %j", (control) => {
    const value = structuredClone(effectiveConfig) as {
      config: Record<string, unknown>;
      layers: unknown;
    };
    delete value.config[control];
    NodeAssert.throws(() => decode(value));
  });

  it.each(
    (
      [
        ["approval_policy", "on-request"],
        ["sandbox_mode", "workspace-write"],
        ["web_search", "live"],
        ["cli_auth_credentials_store", "keyring"],
        ["allow_login_shell", true],
        ["model_provider", "remote-fixture"],
        ["default_permissions", "development"],
        ["permissions", { development: { allow: true } }],
        ["profile", "development"],
        ["profiles", { development: { sandbox_mode: "danger-full-access" } }],
        ["agents", { enabled: true }],
      ] as const
    ).map((value) => [value] as const),
  )("rejects policy fallback through %j", ([control, unsafe]) => {
    const value = structuredClone(effectiveConfig) as { config: Record<string, unknown> };
    value.config[control] = unsafe;
    NodeAssert.throws(() => decode(value));
  });

  it("rejects attached MCP servers and enabled named apps", () => {
    const mcp = structuredClone(effectiveConfig) as { config: Record<string, unknown> };
    mcp.config.mcp_servers = { fixture: { command: "fixture-mcp", enabled: true } };
    NodeAssert.throws(() => decode(mcp));
    const app = structuredClone(effectiveConfig);
    app.config.apps = {
      _default: { enabled: false },
      fixture: { enabled: true },
    } as typeof app.config.apps;
    NodeAssert.throws(() => decode(app));
  });

  it.each(
    ["project", "managed", "managedConfig", "legacyManagedConfigToml", "mdm"].map(
      (value) => [value] as const,
    ),
  )("rejects unsupported %j configuration layers", (type) => {
    NodeAssert.throws(() =>
      decode({
        ...effectiveConfig,
        layers: [...effectiveConfig.layers, { name: { type, file: "/fixture/policy.toml" } }],
      }),
    );
  });

  it("rejects a user layer from another Codex home", () => {
    NodeAssert.throws(() =>
      decode({
        ...effectiveConfig,
        layers: [{ name: { type: "user", file: "/home/fixture/.codex/config.toml" } }],
      }),
    );
  });

  it("rejects managed requirements even if the effective policy looks read-only", () => {
    NodeAssert.throws(() => decodeRequirements({ requirements: {} }));
    NodeAssert.throws(() =>
      decodeRequirements({ requirements: { allowedApprovalPolicies: ["never"] } }),
    );
    NodeAssert.throws(() => decodeRequirements({}));
  });
});

describe("Review native thread receipt", () => {
  const decode = Schema.decodeUnknownSync(reviewThreadReceiptSchema(neutral));

  it("accepts one local neutral workspace with no instruction sources", () => {
    NodeAssert.doesNotThrow(() => decode(threadReceipt));
  });

  it.each(
    (
      [
        ["cwd", "/reviewed-checkout"],
        ["model", "gpt-development"],
        ["approvalPolicy", "on-request"],
        ["sandbox", { type: "workspaceWrite", writableRoots: ["/reviewed-checkout"] }],
        ["sandbox", { type: "readOnly", networkAccess: true }],
        ["activePermissionProfile", "development"],
        ["runtimeWorkspaceRoots", []],
        ["runtimeWorkspaceRoots", [neutral, "/reviewed-checkout"]],
        ["instructionSources", [{ type: "project", path: "/reviewed-checkout/AGENTS.md" }]],
      ] as const
    ).map((value) => [value] as const),
  )("rejects unsafe receipt %j=%j", ([field, value]) => {
    NodeAssert.throws(() => decode({ ...threadReceipt, [field]: value }));
  });

  it.each(
    [
      [],
      [{ environmentId: "remote", cwd: neutral, runtimeWorkspaceRoots: [neutral] }],
      [{ environmentId: "local", cwd: "/reviewed-checkout", runtimeWorkspaceRoots: [neutral] }],
      [{ environmentId: "local", cwd: neutral, runtimeWorkspaceRoots: ["/reviewed-checkout"] }],
      [threadReceipt.thread.environments[0], threadReceipt.thread.environments[0]],
    ].map((value) => [value] as const),
  )("rejects non-neutral or multiple environments %j", (environments) => {
    NodeAssert.throws(() =>
      decode({ ...threadReceipt, thread: { ...threadReceipt.thread, environments } }),
    );
  });

  it.each(
    [
      "cwd",
      "model",
      "approvalPolicy",
      "sandbox",
      "activePermissionProfile",
      "runtimeWorkspaceRoots",
      "instructionSources",
      "thread",
    ].map((value) => [value] as const),
  )("rejects a receipt without %j", (field) => {
    const value: Record<string, unknown> = structuredClone(threadReceipt);
    delete value[field];
    NodeAssert.throws(() => decode(value));
  });
});

describe("Review startup-owned launch configuration", () => {
  const decode = Schema.decodeUnknownSync(CodexReviewLaunchConfig);

  it("accepts immutable native resources and explicit startup ports", () => {
    NodeAssert.deepEqual(decode(launchConfig), launchConfig);
  });

  it.each(
    ["/home/fixture/native", "relative/native", "/nix/store/../../tmp/mutable-native"].map(
      (value) => [value] as const,
    ),
  )("rejects mutable native directory %j", (nativeDirectory) => {
    NodeAssert.throws(() => decode({ ...launchConfig, nativeDirectory }));
  });

  it.each(
    [
      "python3",
      "/usr/bin/python3\nprint('injected')",
      "/usr/bin/python3\r",
      "/path with spaces/python3",
    ].map((value) => [value] as const),
  )("rejects an invalid interpreter %j", (pythonPath) => {
    NodeAssert.throws(() => decode({ ...launchConfig, pythonPath }));
  });

  it("rejects multiline launch environment paths", () => {
    NodeAssert.throws(() => decode({ ...launchConfig, path: "/fixture/bin\nOTHER=unsafe" }));
  });

  it("generates TOML policy and CLI overrides with the same independently checked meaning", () => {
    const spec = reviewLaunchSpec(decode(launchConfig), workspace);
    const parsed = NodeChildProcess.spawnSync(
      "python3",
      [
        "-c",
        String.raw`
import json,sys,tomllib
value=json.load(sys.stdin)
def merge(target, source):
    for key,item in source.items():
        if isinstance(item,dict) and isinstance(target.get(key),dict): merge(target[key],item)
        else: target[key]=item
overrides={}
for override in value['overrides']: merge(overrides,tomllib.loads(override))
print(json.dumps({'policy':tomllib.loads(value['policy']),'overrides':overrides}))
`,
      ],
      {
        input: JSON.stringify({ policy: spec.policy, overrides: spec.overrides }),
        encoding: "utf8",
      },
    );
    NodeAssert.equal(parsed.status, 0, parsed.stderr || String(parsed.error));
    const meanings = JSON.parse(parsed.stdout);
    const expected = {
      approval_policy: "never",
      sandbox_mode: "read-only",
      web_search: "disabled",
      cli_auth_credentials_store: "file",
      allow_login_shell: false,
      features: effectiveConfig.config.features,
      agents: { enabled: false },
      apps: { _default: { enabled: false } },
      mcp_servers: {},
    };
    NodeAssert.deepEqual(meanings.policy, expected);
    NodeAssert.deepEqual(meanings.overrides, expected);
    NodeAssert.equal(spec.workspace, workspace);
    NodeAssert.equal(spec.nativeBinary, `${launchConfig.nativeDirectory}/bin/codex`);
    NodeAssert.equal(spec.nativeVersion, "codex-cli 0.163.0");
    NodeAssert.deepEqual(
      spec.nativeFiles.map((resource) => resource.path),
      [
        `${launchConfig.nativeDirectory}/bin/codex`,
        `${launchConfig.nativeDirectory}/bin/codex-code-mode-host`,
        `${launchConfig.nativeDirectory}/codex-resources/bwrap`,
      ],
    );
    NodeAssert.equal(spec.python, launchConfig.pythonPath);
    NodeAssert.equal(spec.mount, launchConfig.mountPath);
    NodeAssert.equal(spec.unshare, launchConfig.unsharePath);
    NodeAssert.equal(spec.authSource, launchConfig.authSource);
    NodeAssert.equal(spec.path, launchConfig.path);
  });
});
