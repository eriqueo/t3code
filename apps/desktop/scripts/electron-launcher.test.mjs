import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeVM from "node:vm";

import { assert, describe, it } from "vite-plus/test";

import {
  makeDevelopmentEnvironmentScript,
  makeDevelopmentLauncherScript,
  resolveElectronBinaryPath,
  resolveMacLauncherPaths,
  writeDevelopmentLauncherScript,
} from "./electron-launcher.mjs";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone script tests select the host executable format.
const hostPlatform = NodeOS.platform();

async function verifyDesktopChildStop(signal, forwardedArgs = []) {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-child-stop-"));
  const scripts = NodePath.join(directory, "scripts");
  NodeFS.mkdirSync(scripts);
  const marker = NodePath.join(directory, "graceful-child-stop");
  const argumentsPath = NodePath.join(directory, "child-arguments.json");
  const childPath = NodePath.join(directory, "child.mjs");
  NodeFS.writeFileSync(
    childPath,
    `import fs from 'node:fs';
    for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{fs.writeFileSync(${JSON.stringify(marker)},signal);process.exit(0)});
    process.stdout.write(JSON.stringify({pid:process.pid})+'\\n');setInterval(()=>{},1000);
  `,
  );
  NodeFS.copyFileSync(
    new URL("start-electron.mjs", import.meta.url),
    NodePath.join(scripts, "start-electron.mjs"),
  );
  NodeFS.writeFileSync(NodePath.join(scripts, "build-browser-secret.mjs"), "");
  NodeFS.writeFileSync(
    NodePath.join(scripts, "electron-launcher.mjs"),
    `import fs from 'node:fs';export const desktopDir=${JSON.stringify(directory)};export function resolveElectronLaunchCommand(args){fs.writeFileSync(${JSON.stringify(argumentsPath)},JSON.stringify(args));return {electronPath:${JSON.stringify(process.execPath)},args:[${JSON.stringify(childPath)}]}}`,
  );
  const wrapper = NodeChildProcess.spawn(
    process.execPath,
    [NodePath.join(scripts, "start-electron.mjs"), ...forwardedArgs],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, killSignal: "SIGKILL" },
  );
  let childPid;
  let pipeClosed = false;
  const failures = [];
  wrapper.stdout.on("close", () => {
    pipeClosed = true;
  });
  const exited = new Promise((resolve) =>
    wrapper.once("exit", (code, signal) => resolve({ code, signal })),
  );
  try {
    childPid = await new Promise((resolve, reject) => {
      wrapper.once("error", reject);
      wrapper.once("exit", () => reject(new Error("Fixture child exited before readiness")));
      let text = "";
      wrapper.stdout.on("data", (value) => {
        text += value;
        if (text.includes("\n")) {
          resolve(JSON.parse(text).pid);
        }
      });
    });
    assert.deepEqual(JSON.parse(NodeFS.readFileSync(argumentsPath, "utf8")), [
      "dist-electron/main.cjs",
      ...forwardedArgs,
    ]);
    wrapper.kill(signal);
    const result = await exited;
    assert.isTrue(result.code === 0 || result.signal === signal);
    assert.isTrue(NodeFS.existsSync(marker), "wrapper left its captured Electron child running");
    assert.equal(NodeFS.readFileSync(marker, "utf8"), signal);
  } catch (error) {
    failures.push(error);
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill("SIGKILL");
    // The private child's open output pipe confirms this PID still owns the fixture.
    if (childPid && !pipeClosed) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") failures.push(error);
      }
    }
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Desktop child fixture failed");
}

function withRuntimeFixture(run) {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-runtime-port-"));
  const scripts = NodePath.join(directory, "scripts");
  const supplied = NodePath.join(directory, "provided");
  const packageRoot = NodePath.join(directory, "node_modules", "electron");
  const bin = NodePath.join(directory, "bin");
  for (const path of [scripts, supplied, packageRoot, bin]) {
    NodeFS.mkdirSync(path, { recursive: true });
  }
  for (const name of ["electron-launcher.mjs", "ensure-electron-runtime.mjs"]) {
    NodeFS.copyFileSync(new URL(name, import.meta.url), NodePath.join(scripts, name));
  }
  const binary = NodePath.join(supplied, "electron");
  NodeFS.writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o555 });
  NodeFS.chmodSync(supplied, 0o555);
  NodeFS.writeFileSync(
    NodePath.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "electron",
      version: "44.3.0",
      main: "index.js",
    }),
  );
  NodeFS.writeFileSync(
    NodePath.join(packageRoot, "index.js"),
    `module.exports = ${JSON.stringify(binary)};\n`,
  );
  const repair = NodePath.join(directory, "repair-attempted");
  NodeFS.writeFileSync(
    NodePath.join(bin, "curl"),
    '#!/bin/sh\nprintf repair > "$PROBE_REPAIR_MARKER"\nexit 73\n',
    { mode: 0o755 },
  );
  const execute = (module, expression) =>
    NodeChildProcess.spawnSync(
      process.execPath,
      expression === undefined
        ? [NodePath.join(scripts, module)]
        : [
            "--input-type=module",
            "--eval",
            `import * as subject from ${JSON.stringify(NodeURL.pathToFileURL(NodePath.join(scripts, module)).href)}; ${expression}`,
          ],
      {
        env: {
          ...process.env,
          PATH: bin,
          ELECTRON_OVERRIDE_DIST_PATH: supplied,
          PROBE_REPAIR_MARKER: repair,
        },
        encoding: "utf8",
        timeout: 10000,
      },
    );
  try {
    run({ directory, packageRoot, binary, supplied, repair, execute });
  } finally {
    NodeFS.chmodSync(supplied, 0o755);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
}

describe("electron development launcher", () => {
  it.skipIf(hostPlatform !== "linux")(
    "passes incoming desktop URI arguments to Electron",
    async () => {
      await verifyDesktopChildStop("SIGTERM", ["t3code://thread/security-fixture"]);
    },
  );
  it.skipIf(hostPlatform !== "linux")(
    "forwards desktop stop signals to the child before exiting",
    async () => {
      for (const signal of ["SIGINT", "SIGTERM"]) await verifyDesktopChildStop(signal);
    },
  );
  it.skipIf(hostPlatform !== "linux")(
    "leaves Chromium sandbox selection enabled when the setuid helper is absent",
    () => {
      withRuntimeFixture(({ packageRoot, binary, execute }) => {
        NodeFS.mkdirSync(NodePath.join(packageRoot, "dist"));
        NodeFS.copyFileSync(binary, NodePath.join(packageRoot, "dist", "electron"));
        const result = execute(
          "electron-launcher.mjs",
          'process.stdout.write(JSON.stringify(subject.resolveElectronLaunchCommand(["dist-electron/main.cjs"])));',
        );
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {
          electronPath: binary,
          args: ["dist-electron/main.cjs"],
        });
      });
    },
  );

  it.skipIf(hostPlatform !== "linux")(
    "uses the supplied immutable runtime without repairing or fetching the npm runtime",
    () => {
      withRuntimeFixture(({ binary, supplied, repair, execute }) => {
        const result = execute("ensure-electron-runtime.mjs");
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), binary);
        assert.isFalse(NodeFS.existsSync(repair));
        assert.equal(NodeFS.statSync(binary).mode & 0o777, 0o555);
        assert.equal(NodeFS.statSync(supplied).mode & 0o777, 0o555);
      });
    },
  );

  it.skipIf(hostPlatform !== "linux")(
    "refuses an invalid supplied runtime without falling back to a download",
    () => {
      withRuntimeFixture(({ binary, supplied, repair, execute }) => {
        NodeFS.chmodSync(supplied, 0o755);
        NodeFS.unlinkSync(binary);
        NodeFS.chmodSync(supplied, 0o555);
        const result = execute("ensure-electron-runtime.mjs");
        assert.notEqual(result.status, 0);
        assert.isFalse(NodeFS.existsSync(repair));
      });
    },
  );
  it("uses captured values only as fallbacks for a live runner environment", () => {
    const environmentScript = makeDevelopmentEnvironmentScript({
      VITE_DEV_SERVER_URL: "http://127.0.0.1:8526",
      T3CODE_PORT: "16566",
      T3CODE_HOME: "/tmp/t3",
      T3CODE_OTLP_PROTOCOL: "http/protobuf",
    });

    assert.include(
      environmentScript,
      "if [ -z \"${VITE_DEV_SERVER_URL:-}\" ]; then export VITE_DEV_SERVER_URL='http://127.0.0.1:8526'; fi",
    );
    assert.include(
      environmentScript,
      "if [ -z \"${T3CODE_OTLP_PROTOCOL:-}\" ]; then export T3CODE_OTLP_PROTOCOL='http/protobuf'; fi",
    );
    assert.notInclude(environmentScript, "\nexport VITE_DEV_SERVER_URL=");
  });

  it("keeps the launcher script free of volatile environment values", () => {
    const script = makeDevelopmentLauncherScript({
      electronBinaryPath: "/repo/node_modules/electron/Electron",
      mainEntryPath: "/repo/apps/desktop/dist-electron/main.cjs",
      desktopRoot: "/repo/apps/desktop",
      environmentFilePath: "/repo/apps/desktop/.electron-runtime/dev-environment.sh",
    });

    assert.include(
      script,
      "if [ -f '/repo/apps/desktop/.electron-runtime/dev-environment.sh' ]; then . '/repo/apps/desktop/.electron-runtime/dev-environment.sh'; fi",
    );
    assert.notInclude(script, "VITE_DEV_SERVER_URL");
    assert.include(
      script,
      "exec '/repo/node_modules/electron/Electron' --t3code-dev-root='/repo/apps/desktop' '/repo/apps/desktop/dist-electron/main.cjs' \"$@\"",
    );
  });

  it("repairs Electron before loading the package entrypoint", () => {
    const calls = [];
    const electronPath = resolveElectronBinaryPath({
      ensureRuntime: () => {
        calls.push("ensure");
      },
      createRequire: () => (specifier) => {
        calls.push(`require:${specifier}`);
        return "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
      },
      moduleUrl: import.meta.url,
    });

    assert.equal(
      electronPath,
      "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    );
    assert.deepEqual(calls, ["ensure", "require:electron"]);
  });

  it("keeps the native Electron executable name inside the branded macOS bundle", () => {
    const paths = resolveMacLauncherPaths(
      "/repo/apps/desktop/.electron-runtime/T3 Code (Dev).app",
      "T3 Code (Dev)",
    );

    assert.equal(paths.launcherExecutableName, "T3 Code (Dev) Launcher");
    assert.equal(
      paths.launcherBinaryPath,
      "/repo/apps/desktop/.electron-runtime/T3 Code (Dev).app/Contents/MacOS/T3 Code (Dev) Launcher",
    );
    assert.equal(
      paths.runtimeElectronBinaryPath,
      "/repo/apps/desktop/.electron-runtime/T3 Code (Dev).app/Contents/MacOS/Electron",
    );

    const script = makeDevelopmentLauncherScript({
      electronBinaryPath: paths.runtimeElectronBinaryPath,
      mainEntryPath: "/repo/apps/desktop/dist-electron/main.cjs",
      desktopRoot: "/repo/apps/desktop",
      environmentFilePath: "/repo/apps/desktop/.electron-runtime/dev-environment.sh",
    });
    assert.include(
      script,
      "exec '/repo/apps/desktop/.electron-runtime/T3 Code (Dev).app/Contents/MacOS/Electron'",
    );
    assert.notInclude(script, "node_modules/electron");
  });

  it("restores execute permissions on an unchanged launcher", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-launcher-"));
    const launcherPath = NodePath.join(directory, "launcher");
    try {
      writeDevelopmentLauncherScript(launcherPath, "/runtime/Electron");
      NodeFS.chmodSync(launcherPath, 0o644);

      assert.isFalse(writeDevelopmentLauncherScript(launcherPath, "/runtime/Electron"));
      assert.equal(NodeFS.statSync(launcherPath).mode & 0o777, 0o755);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});

// Supply inert imports so the real startup runs without launching Electron or signalling processes.
async function runDevElectronStartup({
  desktopDir = "/repo/apps/desktop",
  spawnSync,
  spawn,
  ...context
}) {
  const source = NodeFS.readFileSync(new URL("./dev-electron.mjs", import.meta.url), "utf8");
  await NodeVM.runInNewContext(
    `(async () => { ${source.replace(/^import\s[\s\S]*?;\n/gm, "")} })()`,
    {
      NodeChildProcess: {
        execFileSync: () => undefined,
        spawnSync: spawnSync ?? (() => undefined),
        spawn: spawn ?? (() => new NodeEvents.EventEmitter()),
      },
      NodeFS: { watch: () => ({ close: () => undefined }) },
      NodeOS: { platform: () => "linux" },
      NodePath,
      desktopDir,
      resolveDevProtocolClient: () => null,
      resolveElectronLaunchCommand: (args) => ({ electronPath: "electron", args }),
      waitForResources: async () => undefined,
      URL,
      ...makeFakeClock(),
      process: {
        env: { VITE_DEV_SERVER_URL: "http://localhost:1234" },
        execPath: "node",
        ppid: 1,
        once: () => undefined,
      },
      ...context,
    },
  );
}

async function startupCleanupPattern(desktopDir) {
  let pattern;
  await runDevElectronStartup({
    desktopDir,
    spawnSync: (command, args) => {
      if (command === "pkill" && args.includes("-f")) pattern = args.at(-1);
    },
  });
  assert.isString(pattern);
  return pattern;
}

function makeFakeClock() {
  let now = 0;
  let timers = [];
  const schedule = (callback, delay, repeat) => {
    const timer = { callback, due: now + (delay ?? 0), repeat: repeat ? (delay ?? 0) : null };
    timer.handle = { unref: () => timer.handle, ref: () => timer.handle };
    timers.push(timer);
    return timer.handle;
  };
  const clear = (handle) => {
    timers = timers.filter((timer) => timer.handle !== handle);
  };
  const flushMicrotasks = async () => {
    for (let index = 0; index < 50; index += 1) await Promise.resolve();
  };
  return {
    setTimeout: (callback, delay) => schedule(callback, delay, false),
    setInterval: (callback, delay) => schedule(callback, delay, true),
    clearTimeout: clear,
    clearInterval: clear,
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await flushMicrotasks();
        const next = timers
          .filter((timer) => timer.due <= end)
          .toSorted((a, b) => a.due - b.due)[0];
        if (!next) break;
        now = next.due;
        if (next.repeat === null) clear(next.handle);
        else next.due = now + Math.max(next.repeat, 1);
        next.callback();
      }
      now = end;
      await flushMicrotasks();
    },
  };
}

it("dev supervisor stops Electron and exits once its parent process goes away", async () => {
  const clock = makeFakeClock();
  let ppid = 4242;
  const exitCodes = [];
  const appSignals = [];
  await runDevElectronStartup({
    ...clock,
    spawn: () => {
      const app = new NodeEvents.EventEmitter();
      app.pid = 5151;
      app.kill = (signal) => {
        appSignals.push(signal);
        app.emit("exit", null, signal);
      };
      return app;
    },
    process: {
      env: { VITE_DEV_SERVER_URL: "http://localhost:1234" },
      execPath: "node",
      pid: 4343,
      get ppid() {
        return ppid;
      },
      once: () => undefined,
      exit: (code) => {
        exitCodes.push(code);
      },
    },
  });

  await clock.advance(5_000);
  assert.deepEqual(appSignals, [], "supervisor stopped Electron while its parent was alive");

  // The launching process died without signalling us; the OS reparented the supervisor.
  ppid = 1;
  await clock.advance(5_000);

  assert.include(
    appSignals,
    "SIGTERM",
    "supervisor kept Electron running after its parent process went away",
  );
  assert.lengthOf(exitCodes, 1, "supervisor did not exit after its parent process went away");
});

it
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Native pgrep is unavailable on Windows.
  .skipIf(NodeOS.platform() === "win32")
  .each([
    "/tmp/t3-feature.one/apps/desktop",
    "/tmp/t3-feature.one [two](three)+?^${four}|back\\slash*/apps/desktop",
  ])("dev cleanup matches only the literal root argument: %s", async (desktopDir) => {
  const pattern = await startupCleanupPattern(desktopDir);
  const flag = `--t3code-dev-root=${desktopDir}`;
  const argvCases = [
    [flag],
    [flag, "main.cjs"],
    [flag.replace(".one", "Xone")],
    [`${flag}-two`],
    [`prefix${flag}`],
    [`--t3code-dev-root=/other${desktopDir}`],
  ];
  const children = [];
  try {
    for (const args of argvCases) {
      const child = NodeChildProcess.spawn(
        process.execPath,
        ["-e", "process.send('ready'); setInterval(() => {}, 1000)", "--", ...args],
        { stdio: ["ignore", "ignore", "inherit", "ipc"] },
      );
      children.push(child);
      await Promise.race([
        NodeEvents.once(child, "message"),
        NodeEvents.once(child, "exit").then(() => {
          throw new Error("Fixture exited before readiness");
        }),
      ]);
    }
    // Use the native ERE engine, but never execute the launcher's signal-producing command.
    const result = NodeChildProcess.spawnSync(
      "pgrep",
      ["-P", String(process.pid), "-f", "--", pattern],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const matches = result.stdout.trim().split(/\s+/).map(Number);
    assert.sameMembers(
      matches,
      children.slice(0, 2).map((child) => child.pid),
    );
  } finally {
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = NodeEvents.once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }),
    );
  }
});
