// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";
import {
  DEFAULT_MODEL,
  ProviderInstanceId,
  REVIEW_PROVIDER_INSTANCE_ID,
  ThreadId,
} from "@t3tools/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import wireFixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import { buildCodexDeveloperInstructions } from "../CodexDeveloperInstructions.ts";
import { codexSessionAppServerArgs } from "./codexLaunchArgs.ts";
import {
  buildTurnStartParams,
  describeMcpElicitation,
  hasConfiguredMcpServer,
  isRecoverableThreadResumeError,
  makeMemoryConsolidationNotificationFilter,
  makeCodexSessionRuntime,
  type CodexSessionRuntimeOptions,
  openCodexThread,
  readCodexThread,
  rollbackCodexThread,
  toMcpElicitationResponse,
} from "./CodexSessionRuntime.ts";
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

for (const policy of ["reserved-id", "explicit-read-only"] as const) {
  it.effect(`Safe Review runtime ${policy} rejects resume before spawning a child process`, () => {
    let spawnCount = 0;
    const spawner = ChildProcessSpawner.make(() => {
      spawnCount += 1;
      return Effect.die("Review resume must fail before child spawn");
    });
    return Effect.gen(function* () {
      const error = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("safe-review-before-spawn"),
        runtimeMode: "full-access",
        providerInstanceId: ProviderInstanceId.make(
          policy === "reserved-id" ? REVIEW_PROVIDER_INSTANCE_ID : "codex",
        ),
        ...(policy === "explicit-read-only" ? { readOnly: true } : {}),
        cwd: "/tmp",
        binaryPath: "/unused-review-fixture-codex",
        environment: {},
        resumeCursor: { threadId: "development-native" },
      }).pipe(Effect.flip);
      NodeAssert.ok(isCodexAppServerRequestError(error));
      NodeAssert.equal(spawnCount, 0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    );
  });
}

// This stdlib-only peer records real JSON-line requests. It cannot run a model,
// tools or native Codex; every response comes from the disposable fixture file.
const reviewPolicyPeer = `#!${process.execPath}
import fs from "node:fs";
import readline from "node:readline";
const fixturePath = process.env.REVIEW_FIXTURE;
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  fs.appendFileSync(fixturePath + ".requests", JSON.stringify(request) + "\\n");
  if (request.id === undefined) return;
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const result = fixture.responses[request.method];
  process.stdout.write(JSON.stringify(result === undefined
    ? { id: request.id, error: { code: -32601, message: "Unscripted request" } }
    : { id: request.id, result }) + "\\n");
});
`;

const makeReviewPolicyFixture = Effect.gen(function* () {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-review-policy-"));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
  );
  const cwd = NodePath.join(directory, "neutral");
  const homePath = NodePath.join(directory, "home");
  NodeFS.mkdirSync(cwd);
  NodeFS.mkdirSync(homePath);
  const peerPath = NodePath.join(directory, "peer.mjs");
  NodeFS.writeFileSync(peerPath, reviewPolicyPeer, { mode: 0o700 });
  const fixturePath = NodePath.join(directory, "fixture.json");
  const responses = {
    initialize: {
      userAgent: "sanitized-review-peer/0.163.0",
      codexHome: homePath,
      platformFamily: "unix",
      platformOs: "linux",
    },
    "configRequirements/read": { requirements: null } as { requirements: unknown },
    "config/read": {
      config: {
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
    },
    "thread/start": {
      ...structuredClone(wireFixture.responses.threadStart),
      cwd,
      model: "gpt-6.1-sol",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: { type: "readOnly", networkAccess: false },
      activePermissionProfile: null,
      runtimeWorkspaceRoots: [cwd],
      instructionSources: [] as string[],
      thread: {
        ...structuredClone(wireFixture.responses.threadStart.thread),
        cwd,
        cliVersion: "0.163.0",
        environments: [{ environmentId: "local", cwd, runtimeWorkspaceRoots: [cwd] }],
      },
    },
    "turn/start": structuredClone(wireFixture.responses.turnStart),
  };
  const save = () => NodeFS.writeFileSync(fixturePath, JSON.stringify({ responses }));
  const requests = () =>
    NodeFS.readFileSync(`${fixturePath}.requests`, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> });
  save();
  const runtime = yield* makeCodexSessionRuntime({
    threadId: ThreadId.make("controlled-review-wire"),
    providerInstanceId: ProviderInstanceId.make(REVIEW_PROVIDER_INSTANCE_ID),
    binaryPath: peerPath,
    runtimeMode: "full-access",
    cwd,
    homePath,
    reviewPolicy: { cwd, homePath },
    model: "gpt-6.1-sol",
    environment: { REVIEW_FIXTURE: fixturePath },
    launchCwd: directory,
  });
  return { runtime, responses, save, requests, cwd };
});

describe("Safe Review controlled runtime policy", () => {
  for (const [name, change] of [
    ["missing trusted policy", { reviewPolicy: undefined }],
    ["different cwd", { cwd: "/tmp/development" }],
    ["different home", { homePath: "/tmp/development-home" }],
    ["different model", { model: "gpt-6-astra" }],
    ["ambient environment", { environment: undefined }],
    ["caller launch overrides", { launchArgs: "--config sandbox_mode=workspace-write" }],
    ["caller app-server overrides", { appServerArgs: ["--config", "features.apps=true"] }],
    ["MCP capability", { mcpCapabilities: new Set(["browser"]) }],
    [
      "policy on an ordinary writable instance",
      { providerInstanceId: ProviderInstanceId.make("codex") },
    ],
  ] as const) {
    it.effect(`rejects ${name} before spawn`, () => {
      let spawns = 0;
      const spawner = ChildProcessSpawner.make(() => {
        spawns += 1;
        return Effect.die("Invalid Review policy reached process spawn");
      });
      return Effect.gen(function* () {
        const unsafeOptions = {
          threadId: ThreadId.make("invalid-review-policy"),
          runtimeMode: "full-access",
          providerInstanceId: ProviderInstanceId.make(REVIEW_PROVIDER_INSTANCE_ID),
          binaryPath: "/unused-review-peer",
          cwd: "/tmp/review-neutral",
          homePath: "/tmp/review-home",
          model: "gpt-6.1-sol",
          environment: {},
          reviewPolicy: { cwd: "/tmp/review-neutral", homePath: "/tmp/review-home" },
          ...change,
        };
        // Deliberately include malformed optional fields to test edge refusal.
        const error = yield* makeCodexSessionRuntime(
          unsafeOptions as CodexSessionRuntimeOptions,
        ).pipe(Effect.flip);
        NodeAssert.ok(isCodexAppServerRequestError(error));
        NodeAssert.equal(error.method, "initialize");
        NodeAssert.equal(spawns, 0);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
        ),
      );
    });
  }

  for (const invalid of ["managed requirements", "enabled feature", "wrong user layer"] as const) {
    it.effect(`rejects ${invalid} after initialize and before thread/start`, () =>
      Effect.gen(function* () {
        const fixture = yield* makeReviewPolicyFixture;
        if (invalid === "managed requirements")
          fixture.responses["configRequirements/read"].requirements = {};
        if (invalid === "enabled feature")
          fixture.responses["config/read"].config.features.apps = true;
        if (invalid === "wrong user layer")
          fixture.responses["config/read"].layers[1]!.name.file = "/tmp/development/config.toml";
        fixture.save();
        const error = yield* fixture.runtime.start().pipe(Effect.flip);
        NodeAssert.ok(isCodexAppServerRequestError(error));
        const methods = fixture.requests().map((request) => request.method);
        NodeAssert.deepEqual(methods.slice(0, 3), [
          "initialize",
          "initialized",
          "configRequirements/read",
        ]);
        NodeAssert.ok(!methods.includes("thread/start"));
        NodeAssert.ok(!methods.includes("turn/start"));
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  }

  it.effect("accepts matching native receipts and rechecks before each turn", () =>
    Effect.gen(function* () {
      const fixture = yield* makeReviewPolicyFixture;
      const session = yield* fixture.runtime.start();
      NodeAssert.equal(session.status, "ready");
      NodeAssert.equal(session.cwd, fixture.cwd);
      for (const input of ["first disposable turn", "second disposable turn"]) {
        yield* fixture.runtime.sendTurn({ input });
      }
      const requests = fixture.requests();
      NodeAssert.deepEqual(
        requests.map((request) => request.method),
        [
          "initialize",
          "initialized",
          "configRequirements/read",
          "config/read",
          "thread/start",
          "configRequirements/read",
          "config/read",
          "turn/start",
          "configRequirements/read",
          "config/read",
          "turn/start",
        ],
      );
      for (const request of requests.filter((request) =>
        ["thread/start", "turn/start"].includes(request.method),
      )) {
        NodeAssert.equal(request.params?.cwd, fixture.cwd);
        NodeAssert.equal(request.params?.approvalPolicy, "never");
        NodeAssert.deepEqual(request.params?.runtimeWorkspaceRoots, [fixture.cwd]);
      }
      NodeAssert.equal(requests[4]?.params?.sandbox, "read-only");
      NodeAssert.deepEqual(requests[4]?.params?.selectedCapabilityRoots, []);
      NodeAssert.deepEqual(requests[4]?.params?.dynamicTools, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("blocks configuration drift before a later native turn", () =>
    Effect.gen(function* () {
      const fixture = yield* makeReviewPolicyFixture;
      yield* fixture.runtime.start();
      yield* fixture.runtime.sendTurn({ input: "permitted fixture turn" });
      fixture.responses["config/read"].config.features.apps = true;
      fixture.save();
      const error = yield* fixture.runtime
        .sendTurn({ input: "must not reach native turn" })
        .pipe(Effect.flip);
      NodeAssert.ok(isCodexAppServerRequestError(error));
      NodeAssert.equal(
        fixture.requests().filter((request) => request.method === "turn/start").length,
        1,
      );
      NodeAssert.deepEqual(
        fixture
          .requests()
          .slice(-2)
          .map((request) => request.method),
        ["configRequirements/read", "config/read"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a model override before any additional native RPC", () =>
    Effect.gen(function* () {
      const fixture = yield* makeReviewPolicyFixture;
      yield* fixture.runtime.start();
      const before = fixture.requests();
      const error = yield* fixture.runtime
        .sendTurn({ input: "blocked override", model: "gpt-6-astra" })
        .pipe(Effect.flip);
      NodeAssert.ok(isCodexAppServerRequestError(error));
      NodeAssert.equal(error.method, "turn/start");
      NodeAssert.deepEqual(fixture.requests(), before);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a native thread that loaded development instructions", () =>
    Effect.gen(function* () {
      const fixture = yield* makeReviewPolicyFixture;
      fixture.responses["thread/start"].instructionSources = ["/tmp/development/AGENTS.md"];
      fixture.save();
      const error = yield* fixture.runtime.start().pipe(Effect.flip);
      NodeAssert.ok(isCodexAppServerRequestError(error));
      NodeAssert.equal(error.method, "thread/start");
      NodeAssert.equal(fixture.requests().at(-1)?.method, "thread/start");
      NodeAssert.notEqual((yield* fixture.runtime.getSession).status, "ready");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("Codex thread history", () => {
  for (const numTurns of [1, 2, 3, 5]) {
    it.effect(`reverts ${numTurns} paginated turns at the durable boundary`, () =>
      Effect.gen(function* () {
        let retained = ["turn-1", "turn-2", "turn-3"];
        const client: Parameters<typeof rollbackCodexThread>[0] = {
          request: () => Effect.die("Legacy history API must not be used for paginated threads"),
          raw: {
            request: (method, params) =>
              Effect.sync(() => {
                if (method === "thread/read") return { thread: { historyMode: "paginated" } };
                if (method === "thread/turns/list") {
                  const { cursor } = params as { cursor: string | null };
                  const start = cursor === null ? 0 : Number(cursor);
                  const ids = retained.slice(start, start + 2);
                  return {
                    data: ids.map((id) => ({ id, items: [], status: "completed" })),
                    nextCursor: start + 2 < retained.length ? String(start + 2) : null,
                  };
                }
                NodeAssert.equal(method, "thread/revert");
                const { beforeTurnId } = params as { beforeTurnId: string };
                retained = retained.slice(0, retained.indexOf(beforeTurnId));
                return { thread: { id: "thread-1", turns: [] } };
              }),
          },
        };
        const result = yield* rollbackCodexThread(client, "thread-1", numTurns);
        const expected = ["turn-1", "turn-2", "turn-3"].slice(0, Math.max(0, 3 - numTurns));
        NodeAssert.deepEqual(
          result.turns.map((turn) => turn.id),
          expected,
        );
        NodeAssert.deepEqual(
          (yield* readCodexThread(client, "thread-1")).turns.map((turn) => turn.id),
          expected,
        );
      }),
    );
  }

  for (const cursors of [
    ["next", "next"],
    ["first", "second", "first"],
  ]) {
    it.effect(`rejects a pagination cursor cycle: ${cursors.join(", ")}`, () =>
      Effect.gen(function* () {
        let pageCount = 0;
        const client: Parameters<typeof readCodexThread>[0] = {
          request: () => Effect.die("Unexpected legacy request"),
          raw: {
            request: (method) =>
              Effect.sync(() => {
                if (method === "thread/read") return { thread: { historyMode: "paginated" } };
                NodeAssert.ok(pageCount < cursors.length, "Repeated cursor was requested");
                return { data: [], nextCursor: cursors[pageCount++] };
              }),
          },
        };
        const error = yield* Effect.flip(readCodexThread(client, "thread-1"));
        NodeAssert.ok(isCodexAppServerRequestError(error));
        NodeAssert.equal(pageCount, cursors.length);
      }),
    );
  }

  it.effect("keeps the count-based rollback API for older threads", () =>
    Effect.gen(function* () {
      const client: Parameters<typeof rollbackCodexThread>[0] = {
        raw: { request: () => Effect.succeed({ thread: {} }) },
        request: <M extends CodexRpc.ClientRequestMethod>(
          method: M,
          params: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          NodeAssert.equal(method, "thread/rollback");
          NodeAssert.deepEqual(params, { threadId: "legacy-thread", numTurns: 2 });
          return Effect.succeed({
            thread: { id: "legacy-thread", turns: [] },
          } as unknown as CodexRpc.ClientRequestResponsesByMethod[M]);
        },
      };
      NodeAssert.deepEqual(yield* rollbackCodexThread(client, "legacy-thread", 2), {
        threadId: "legacy-thread",
        turns: [],
      });
    }),
  );
});

describe("CodexSessionRuntimeIdentifierGenerationError", () => {
  it("retains identifier purpose and the random source failure", () => {
    const cause = new Error("random source unavailable");
    const error = new CodexErrors.CodexAppServerIdentifierGenerationError({
      purpose: "provider-event",
      cause,
    });

    NodeAssert.equal(error.purpose, "provider-event");
    NodeAssert.strictEqual(error.cause, cause);
    NodeAssert.equal(
      error.message,
      "Failed to generate Codex App Server identifier for provider-event.",
    );
  });
});

function makeThreadOpenResponse(
  threadId: string,
): CodexRpc.ClientRequestResponsesByMethod["thread/start"] {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "danger-full-access" },
    thread: {
      id: threadId,
      createdAt: "2026-04-18T00:00:00.000Z",
      source: { session: "cli" },
      turns: [],
      status: {
        state: "idle",
        activeFlags: [],
      },
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];
}

describe("buildTurnStartParams", () => {
  it("keeps invalid turn values only in the schema cause", () => {
    const secret = "codex-turn-input-secret-sentinel";
    const error = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        attachments: [
          {
            type: "image",
            url: { secret } as unknown as string,
          },
        ],
      }).pipe(Effect.flip),
    );
    const { cause, ...directDiagnostics } = error;

    NodeAssert.equal(error.operation, "decode-request-payload");
    NodeAssert.equal(error.method, "turn/start");
    NodeAssert.ok((error.issueCount ?? 0) > 0);
    NodeAssert.ok(error.issueKinds?.includes("Pointer"));
    NodeAssert.ok((error.maximumPathDepth ?? 0) > 0);
    NodeAssert.ok(Schema.isSchemaError(cause));
    NodeAssert.doesNotMatch(error.message, new RegExp(secret));
    NodeAssert.doesNotMatch(JSON.stringify(directDiagnostics), new RegExp(secret));
  });

  it("includes plan collaboration mode when requested", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Make a plan",
        model: "gpt-5.3-codex",
        effort: "medium",
        interactionMode: "plan",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
      input: [
        {
          type: "text",
          text: "Make a plan",
        },
      ],
      model: "gpt-5.3-codex",
      effort: "medium",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions("plan", {
            model: "gpt-5.3-codex",
            reasoningEffort: "medium",
          }),
        },
      },
    });
  });

  it("includes default collaboration mode and image attachments", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        model: "gpt-5.3-codex",
        interactionMode: "default",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      input: [
        {
          type: "text",
          text: "Implement it",
        },
        {
          type: "image",
          url: "data:image/png;base64,abc",
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions("default", {
            model: "gpt-5.3-codex",
            reasoningEffort: "medium",
          }),
        },
      },
    });
  });

  it("reports the same fallback model and effort in settings and instructions", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Go",
        interactionMode: "default",
      }),
    );

    const settings = params.collaborationMode?.settings;
    NodeAssert.equal(settings?.model, DEFAULT_MODEL);
    NodeAssert.equal(settings?.reasoning_effort, "medium");
    NodeAssert.ok(settings?.developer_instructions?.includes(`as ${DEFAULT_MODEL} with medium`));
  });

  it.effect("routes approvals to the auto reviewer in auto mode", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto",
        prompt: "Ship it",
      });

      NodeAssert.deepStrictEqual(params, {
        threadId: "provider-thread-1",
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandboxPolicy: {
          type: "workspaceWrite",
        },
        input: [
          {
            type: "text",
            text: "Ship it",
          },
        ],
      });
    }),
  );

  it.effect("forces a Review instance to read-only even when full access is requested", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "review-thread",
        runtimeMode: "full-access",
        readOnly: true,
        prompt: "Review evidence",
      });
      NodeAssert.equal(params.approvalPolicy, "never");
      NodeAssert.deepStrictEqual(params.sandboxPolicy, { type: "readOnly", networkAccess: false });
    }),
  );

  it("omits collaboration mode when interaction mode is absent", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Review",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "readOnly",
      },
      input: [
        {
          type: "text",
          text: "Review",
        },
      ],
    });
  });
});

describe("Codex MCP elicitation approvals", () => {
  const request = {
    mode: "form",
    message: "Allow ChatGPT to use Safari?",
    serverName: "computer-use",
    threadId: "provider-thread-1",
    turnId: "turn-1",
    _meta: {
      app_name: "Safari",
      persist: ["session", "always"],
    },
    requestedSchema: {
      type: "object",
      properties: {
        approval: {
          type: "string",
          oneOf: [
            { const: "once", title: "Allow once" },
            { const: "session", title: "Allow for this session" },
            { const: "always", title: "Always allow Safari" },
          ],
        },
      },
      required: ["approval"],
    },
  } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

  it("preserves the app name and advertised persistence choices", () => {
    NodeAssert.deepStrictEqual(describeMcpElicitation(request), {
      appName: "Safari",
      options: [
        { decision: "cancel", label: "Cancel" },
        { decision: "decline", label: "Decline" },
        { decision: "acceptForSession", label: "Allow for this session" },
        { decision: "acceptAlways", label: "Always allow Safari" },
        { decision: "accept", label: "Approve" },
      ],
    });
  });

  it("extracts the app name from a Computer Use request without metadata", () => {
    const { _meta, ...requestWithoutMetadata } = request;

    NodeAssert.equal(describeMcpElicitation(requestWithoutMetadata).appName, "Safari");
  });

  it("returns the accepted form option to Codex", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "accept"), {
      action: "accept",
      content: { approval: "once" },
    });
  });

  it("returns session-scoped approval in the MCP response", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "acceptForSession"), {
      action: "accept",
      _meta: { persist: "session" },
      content: { approval: "session" },
    });
  });

  it("returns persistent approval in the MCP response", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { approval: "always" },
    });
  });

  it("returns rejection without form content", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "decline"), {
      action: "decline",
    });
  });

  it("returns cancellation without form content", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "cancel"), {
      action: "cancel",
    });
  });

  it("supports boolean permanent-approval fields", () => {
    const booleanRequest = {
      ...request,
      _meta: { app_name: "Safari" },
      requestedSchema: {
        type: "object",
        properties: {
          always: { type: "boolean", title: "Always allow Safari" },
        },
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.ok(
      describeMcpElicitation(booleanRequest).options.some(
        (option) => option.decision === "acceptAlways",
      ),
    );
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(booleanRequest, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { always: true },
    });
  });

  it("preserves valid nullable MCP form fields and persistence choices", () => {
    const nullableRequest = {
      ...request,
      _meta: {
        app_name: null,
        appName: "Safari",
        connector_name: null,
        persist: null,
        target: null,
        tool_params: null,
      },
      requestedSchema: {
        type: "object",
        properties: {
          approval: {
            type: "string",
            title: null,
            description: null,
            default: null,
            enum: ["once", "always"],
            enumNames: null,
          },
        },
        required: ["approval"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.equal(describeMcpElicitation(nullableRequest).appName, "Safari");
    NodeAssert.ok(
      describeMcpElicitation(nullableRequest).options.some(
        (option) => option.decision === "acceptAlways",
      ),
    );
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(nullableRequest, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { approval: "always" },
    });
  });

  it("declines required form fields that an approval prompt cannot collect", () => {
    const inputRequest = {
      ...request,
      requestedSchema: {
        type: "object",
        properties: {
          email: { type: "string", format: "email" },
        },
        required: ["email"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(toMcpElicitationResponse(inputRequest, "accept"), {
      action: "decline",
    });
  });

  it("does not approve URL elicitations without opening their requested URL", () => {
    const urlRequest = {
      mode: "url",
      message: "Finish signing in to continue.",
      serverName: "computer-use",
      threadId: "provider-thread-1",
      turnId: "turn-1",
      elicitationId: "sign-in-1",
      url: "https://example.com/authorize",
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(toMcpElicitationResponse(urlRequest, "accept"), {
      action: "decline",
    });
  });

  it("omits persistence choices that cannot satisfy required form fields", () => {
    const onceOnlyRequest = {
      ...request,
      _meta: { app_name: "Safari", persist: ["session", "always"] },
      requestedSchema: {
        type: "object",
        properties: {
          approval: {
            type: "string",
            enum: ["once"],
          },
        },
        required: ["approval"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(describeMcpElicitation(onceOnlyRequest).options, [
      { decision: "cancel", label: "Cancel" },
      { decision: "decline", label: "Decline" },
      { decision: "accept", label: "Approve" },
    ]);
  });
});

describe("buildCodexDeveloperInstructions", () => {
  it("appends runtime info after the mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
    });

    NodeAssert.match(instructions, /^<collaboration_mode># Collaboration Mode: Default/);
    NodeAssert.match(instructions, /T3 Code/);
    NodeAssert.match(instructions, /Codex harness/);
    NodeAssert.match(instructions, /as gpt-5\.3-codex with high reasoning effort/);
  });

  it("describes Markdown media support in the runtime context in both modes", () => {
    for (const mode of ["default", "plan"] as const) {
      const instructions = buildCodexDeveloperInstructions(mode, {
        model: "gpt-5.3-codex",
        reasoningEffort: "high",
      });
      NodeAssert.match(
        instructions,
        /<runtime_info>.*embed images and videos.*Markdown.*<\/runtime_info>/,
      );
    }
  });

  it("includes runtime info alongside plan mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("plan", {
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });

    NodeAssert.match(instructions, /^<collaboration_mode># Plan Mode/);
    NodeAssert.match(instructions, /as gpt-5\.3-codex with medium reasoning effort/);
  });

  it("varies with the model and effort of each turn", () => {
    const first = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });
    const second = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.4",
      reasoningEffort: "high",
    });

    NodeAssert.notEqual(first, second);
  });

  it("flattens multiline metadata into single-line runtime info", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt\n5.3\ncodex",
      reasoningEffort: " high\neffort ",
    });

    NodeAssert.match(instructions, /as gpt 5\.3 codex with high effort reasoning effort/);
    NodeAssert.doesNotMatch(instructions, /<runtime_info>[^<]*\n/);
  });
});

describe("T3 browser developer instructions", () => {
  const runtime = { model: "gpt-5.3-codex", reasoningEffort: "high" };

  it("prefers the product-native preview tools in both collaboration modes", () => {
    for (const mode of ["default", "plan"] as const) {
      const instructions = buildCodexDeveloperInstructions(mode, runtime, true);
      NodeAssert.match(instructions, /t3-code/);
      NodeAssert.match(instructions, /preview_status/);
      NodeAssert.match(instructions, /preview_open/);
      NodeAssert.match(instructions, /Do not switch to global browser skills/);
    }
  });

  it("omits the browser block entirely when the preview tools are not attached", () => {
    for (const mode of ["default", "plan"] as const) {
      const instructions = buildCodexDeveloperInstructions(mode, runtime, false);
      NodeAssert.doesNotMatch(instructions, /preview_status/);
      NodeAssert.doesNotMatch(instructions, /preview_open/);
      NodeAssert.doesNotMatch(instructions, /T3 Code collaborative browser/);
      // Steering away from other browser automation must go with the tools;
      // keeping it would leave the model talked out of its only option.
      NodeAssert.doesNotMatch(instructions, /Do not switch to global browser skills/);
      // The rest of the collaboration mode is untouched.
      NodeAssert.match(instructions, /<collaboration_mode>/);
      NodeAssert.match(instructions, /<\/collaboration_mode>/);
    }
  });

  it("tracks the turn's MCP configuration rather than defaulting to on", () => {
    NodeAssert.match(buildCodexDeveloperInstructions("default", runtime, true), /preview_open/);
    NodeAssert.doesNotMatch(
      buildCodexDeveloperInstructions("default", runtime, false),
      /preview_open/,
    );
  });
});

describe("hasConfiguredMcpServer", () => {
  it("detects inline Codex MCP configuration arguments", () => {
    NodeAssert.equal(hasConfiguredMcpServer(undefined), false);
    NodeAssert.equal(hasConfiguredMcpServer(["--model", "gpt-5.4"]), false);
    NodeAssert.equal(
      hasConfiguredMcpServer(["-c", 'mcp_servers.t3-code.url="http://127.0.0.1/mcp"']),
      true,
    );
  });
});

function makeThreadStartedNotification(
  threadId: string,
  source: EffectCodexSchema.V2ThreadStartedNotification["thread"]["source"],
  threadSource?: string,
) {
  return {
    method: "thread/started" as const,
    params: {
      thread: {
        cliVersion: "0.0.0",
        createdAt: 0,
        cwd: "/tmp/project",
        ephemeral: true,
        id: threadId,
        modelProvider: "openai",
        preview: "",
        sessionId: threadId,
        source,
        status: { type: "idle" as const },
        ...(threadSource ? { threadSource } : {}),
        turns: [],
        updatedAt: 0,
      },
    },
  };
}

describe("makeMemoryConsolidationNotificationFilter", () => {
  it("suppresses memory consolidation without hiding other Codex subagents", () => {
    const shouldSuppress = makeMemoryConsolidationNotificationFilter();

    NodeAssert.equal(
      shouldSuppress(
        makeThreadStartedNotification("memory-thread", "unknown", "memory_consolidation"),
      ),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "item/agentMessage/delta",
        params: {
          delta: "internal memory update",
          itemId: "memory-message",
          threadId: "memory-thread",
          turnId: "memory-turn",
        },
      }),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "serverRequest/resolved",
        params: {
          requestId: "memory-approval",
          threadId: "memory-thread",
        },
      }),
      false,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "warning",
        params: {
          message: "internal warning",
          threadId: "memory-thread",
        },
      }),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "item/agentMessage/delta",
        params: {
          delta: "normal reply",
          itemId: "root-message",
          threadId: "root-thread",
          turnId: "root-turn",
        },
      }),
      false,
    );

    NodeAssert.equal(
      shouldSuppress(
        makeThreadStartedNotification("legacy-memory-thread", {
          subAgent: "memory_consolidation",
        }),
      ),
      true,
    );

    for (const source of [
      { subAgent: "review" as const },
      { subAgent: "compact" as const },
      {
        subAgent: {
          thread_spawn: {
            depth: 1,
            parent_thread_id: "root-thread",
          },
        },
      },
    ]) {
      NodeAssert.equal(
        shouldSuppress(makeThreadStartedNotification("visible-subagent", source)),
        false,
      );
    }
  });

  it("forgets memory consolidation threads after they close", () => {
    const shouldSuppress = makeMemoryConsolidationNotificationFilter();
    shouldSuppress(
      makeThreadStartedNotification("memory-thread", "unknown", "memory_consolidation"),
    );

    NodeAssert.equal(
      shouldSuppress({
        method: "thread/closed",
        params: { threadId: "memory-thread" },
      }),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "item/agentMessage/delta",
        params: {
          delta: "later message",
          itemId: "later-message",
          threadId: "memory-thread",
          turnId: "later-turn",
        },
      }),
      false,
    );
  });
});

describe("codexSessionAppServerArgs", () => {
  it("keeps the app-server subcommand when explicit args are provided", () => {
    NodeAssert.deepStrictEqual(codexSessionAppServerArgs(["-c", "model=gpt-5"], undefined), [
      "app-server",
      "-c",
      "model=gpt-5",
    ]);
  });

  it("keeps launch args when explicit app-server args are provided", () => {
    NodeAssert.deepStrictEqual(
      codexSessionAppServerArgs(
        ["-c", "mcp_servers.t3-code.url=http://127.0.0.1/mcp"],
        "--strict-config --enable foo",
      ),
      [
        "app-server",
        "--strict-config",
        "--enable",
        "foo",
        "-c",
        "mcp_servers.t3-code.url=http://127.0.0.1/mcp",
      ],
    );
  });
});

describe("isRecoverableThreadResumeError", () => {
  it("matches missing thread errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Thread does not exist",
        }),
      ),
      true,
    );
  });

  it("matches a missing rollout for a known thread id", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "no rollout found for thread id 019fdf74-aaa9-7950-b252-7cc7a8650470",
        }),
      ),
      true,
    );
  });

  it("ignores non-recoverable resume errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Permission denied",
        }),
      ),
      false,
    );
  });

  it("ignores unrelated missing-resource errors that do not mention threads", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Config file not found",
        }),
      ),
      false,
    );
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Model does not exist",
        }),
      ),
      false,
    );
  });
});

describe("openCodexThread", () => {
  it.effect("starts read-only without a user approval even when full access was requested", () =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      yield* openCodexThread({
        client: {
          request: (method, params) => {
            calls.push({ method, params });
            return Effect.succeed(makeThreadOpenResponse("review-thread"));
          },
          raw: { request: () => Effect.die("Review must not resume") },
        },
        threadId: ThreadId.make("review-thread"),
        runtimeMode: "full-access",
        readOnly: true,
        cwd: "/tmp/project",
        requestedModel: undefined,
        serviceTier: undefined,
        resumeThreadId: undefined,
      });
      NodeAssert.deepStrictEqual(calls, [
        {
          method: "thread/start",
          params: {
            cwd: "/tmp/project",
            approvalPolicy: "never",
            sandbox: "read-only",
            approvalsReviewer: "user",
          },
        },
      ]);
    }),
  );

  it.effect("rejects a read-only resume before either resume or fresh-start RPC", () =>
    Effect.gen(function* () {
      const error = yield* openCodexThread({
        client: {
          request: () => Effect.die("Review resume must not fall back to a new thread"),
          raw: { request: () => Effect.die("Review must not resume an existing thread") },
        },
        threadId: ThreadId.make("review-thread"),
        runtimeMode: "full-access",
        readOnly: true,
        cwd: "/tmp/project",
        requestedModel: undefined,
        serviceTier: undefined,
        resumeThreadId: "development-thread",
      }).pipe(Effect.flip);
      NodeAssert.ok(isCodexAppServerRequestError(error));
      NodeAssert.equal(error.method, "thread/resume");
    }),
  );

  it.effect("resumes metadata when historical turns contain unknown error values", () =>
    Effect.gen(function* () {
      const response = makeThreadOpenResponse("saved-thread");
      const calls: unknown[] = [];
      const opened = yield* openCodexThread({
        client: {
          request: () => Effect.die("A valid resumed thread must not start fresh"),
          raw: {
            request: (method, payload) => {
              calls.push({ method, payload });
              return Effect.succeed({
                ...response,
                thread: {
                  ...response.thread,
                  turns: [
                    {
                      id: "old-turn",
                      status: "failed",
                      items: [],
                      error: {
                        message: "Historical provider error",
                        codexErrorInfo: "misalignment_policy_violation",
                      },
                    },
                  ],
                },
              });
            },
          },
        },
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "auto",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: "fast",
        resumeThreadId: "saved-thread",
      });

      NodeAssert.deepStrictEqual(opened, {
        cwd: response.cwd,
        model: response.model,
        thread: { id: "saved-thread" },
      });
      NodeAssert.deepStrictEqual(calls, [
        {
          method: "thread/resume",
          payload: {
            threadId: "saved-thread",
            cwd: "/tmp/project",
            model: "gpt-5.3-codex",
            serviceTier: "fast",
            approvalPolicy: "on-request",
            sandbox: "workspace-write",
            approvalsReviewer: "auto_review",
            excludeTurns: true,
          },
        },
      ]);
    }),
  );

  it.effect("rejects malformed required resume metadata without starting a fresh thread", () =>
    Effect.gen(function* () {
      for (const invalidMetadata of [
        { cwd: null },
        { model: 42 },
        { thread: { id: null } },
        { thread: {} },
      ]) {
        const error = yield* openCodexThread({
          client: {
            request: () => Effect.die("Invalid resume metadata must not start a fresh thread"),
            raw: {
              request: () =>
                Effect.succeed({ ...makeThreadOpenResponse("saved-thread"), ...invalidMetadata }),
            },
          },
          threadId: ThreadId.make("thread-1"),
          runtimeMode: "full-access",
          cwd: "/tmp/project",
          requestedModel: "gpt-5.3-codex",
          serviceTier: undefined,
          resumeThreadId: "saved-thread",
        }).pipe(Effect.flip);

        NodeAssert.ok(isCodexAppServerRequestError(error));
        NodeAssert.equal(error.operation, "decode-payload");
        NodeAssert.equal(error.method, "thread/resume");
      }
    }),
  );

  it.effect("falls back to thread/start when resume fails recoverably", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
      const started = makeThreadOpenResponse("fresh-thread");
      const client = {
        raw: {
          request: (
            method: "thread/resume" | "thread/start",
            payload:
              | CodexRpc.ClientRequestParamsByMethod["thread/resume"]
              | CodexRpc.ClientRequestParamsByMethod["thread/start"],
          ) => {
            NodeAssert.equal(method, "thread/resume");
            calls.push({ method, payload });
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "thread not found",
              }),
            );
          },
        },
        request: (
          method: "thread/start",
          payload: CodexRpc.ClientRequestParamsByMethod["thread/start"],
        ) => {
          calls.push({ method, payload });
          return Effect.succeed(started);
        },
      };

      const opened = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      });

      NodeAssert.equal(opened.thread.id, "fresh-thread");
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["thread/resume", "thread/start"],
      );
    }),
  );

  it.effect("propagates non-recoverable resume failures", () =>
    Effect.gen(function* () {
      const client = {
        request: () => Effect.die("Non-recoverable resume failures must not start a fresh thread"),
        raw: {
          request: () =>
            Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "timed out waiting for server",
              }),
            ),
        },
      };

      const error = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      }).pipe(Effect.flip);

      NodeAssert.ok(isCodexAppServerRequestError(error));
      NodeAssert.equal(error.errorMessage, "timed out waiting for server");
    }),
  );
});
