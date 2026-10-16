// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as Schema from "effect/Schema";
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

describe("Review effective native configuration", () => {
  const decode = Schema.decodeUnknownSync(reviewEffectiveConfigSchema(homePath));

  it("accepts the sanitized 0.163 configuration and no managed requirements", () => {
    NodeAssert.doesNotThrow(() => decode(effectiveConfig));
    NodeAssert.deepEqual(decodeRequirements({ requirements: null }), {
      requirements: null,
    });
  });

  for (const feature of Object.keys(effectiveConfig.config.features)) {
    it(`rejects changing required feature ${feature}`, () => {
      const value = structuredClone(effectiveConfig);
      const key = feature as keyof typeof value.config.features;
      value.config.features[key] = !value.config.features[key];
      NodeAssert.throws(() => decode(value));
    });
  }

  it("requires the isolated code_mode_host while keeping ordinary code_mode disabled", () => {
    const decoded = decode(effectiveConfig);
    NodeAssert.equal(decoded.config.features.code_mode_host, true);
    NodeAssert.equal(decoded.config.features.code_mode, false);
    const missingHost = structuredClone(effectiveConfig) as Record<string, unknown>;
    const config = missingHost.config as { features: Record<string, unknown> };
    delete config.features.code_mode_host;
    NodeAssert.throws(() => decode(missingHost));
  });

  for (const control of Object.keys(effectiveConfig.config)) {
    if (control === "model" || control === "model_reasoning_effort") continue;
    it(`rejects missing containment control ${control}`, () => {
      const value = structuredClone(effectiveConfig) as {
        config: Record<string, unknown>;
        layers: unknown;
      };
      delete value.config[control];
      NodeAssert.throws(() => decode(value));
    });
  }

  for (const [control, unsafe] of [
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
  ] as const) {
    it(`rejects policy fallback through ${control}`, () => {
      const value = structuredClone(effectiveConfig) as { config: Record<string, unknown> };
      value.config[control] = unsafe;
      NodeAssert.throws(() => decode(value));
    });
  }

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

  for (const type of ["project", "managed", "managedConfig", "legacyManagedConfigToml", "mdm"]) {
    it(`rejects unsupported ${type} configuration layers`, () => {
      NodeAssert.throws(() =>
        decode({
          ...effectiveConfig,
          layers: [...effectiveConfig.layers, { name: { type, file: "/fixture/policy.toml" } }],
        }),
      );
    });
  }

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

  for (const [field, value] of [
    ["cwd", "/reviewed-checkout"],
    ["model", "gpt-development"],
    ["approvalPolicy", "on-request"],
    ["sandbox", { type: "workspaceWrite", writableRoots: ["/reviewed-checkout"] }],
    ["sandbox", { type: "readOnly", networkAccess: true }],
    ["activePermissionProfile", "development"],
    ["runtimeWorkspaceRoots", []],
    ["runtimeWorkspaceRoots", [neutral, "/reviewed-checkout"]],
    ["instructionSources", [{ type: "project", path: "/reviewed-checkout/AGENTS.md" }]],
  ] as const) {
    it(`rejects unsafe receipt ${field}=${JSON.stringify(value)}`, () => {
      NodeAssert.throws(() => decode({ ...threadReceipt, [field]: value }));
    });
  }

  for (const environments of [
    [],
    [{ environmentId: "remote", cwd: neutral, runtimeWorkspaceRoots: [neutral] }],
    [{ environmentId: "local", cwd: "/reviewed-checkout", runtimeWorkspaceRoots: [neutral] }],
    [{ environmentId: "local", cwd: neutral, runtimeWorkspaceRoots: ["/reviewed-checkout"] }],
    [threadReceipt.thread.environments[0], threadReceipt.thread.environments[0]],
  ]) {
    it(`rejects non-neutral or multiple environments ${JSON.stringify(environments)}`, () => {
      NodeAssert.throws(() =>
        decode({ ...threadReceipt, thread: { ...threadReceipt.thread, environments } }),
      );
    });
  }

  for (const field of [
    "cwd",
    "model",
    "approvalPolicy",
    "sandbox",
    "activePermissionProfile",
    "runtimeWorkspaceRoots",
    "instructionSources",
    "thread",
  ]) {
    it(`rejects a receipt without ${field}`, () => {
      const value: Record<string, unknown> = structuredClone(threadReceipt);
      delete value[field];
      NodeAssert.throws(() => decode(value));
    });
  }
});

describe("Review startup-owned launch configuration", () => {
  const decode = Schema.decodeUnknownSync(CodexReviewLaunchConfig);

  it("accepts immutable native resources and explicit startup ports", () => {
    NodeAssert.deepEqual(decode(launchConfig), launchConfig);
  });

  for (const nativeDirectory of [
    "/home/fixture/native",
    "relative/native",
    "/nix/store/../../tmp/mutable-native",
  ]) {
    it(`rejects mutable native directory ${nativeDirectory}`, () => {
      NodeAssert.throws(() => decode({ ...launchConfig, nativeDirectory }));
    });
  }

  for (const pythonPath of [
    "python3",
    "/usr/bin/python3\nprint('injected')",
    "/usr/bin/python3\r",
    "/path with spaces/python3",
  ]) {
    it(`rejects an invalid interpreter ${JSON.stringify(pythonPath)}`, () => {
      NodeAssert.throws(() => decode({ ...launchConfig, pythonPath }));
    });
  }

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
