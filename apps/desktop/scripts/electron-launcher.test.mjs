import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, describe, it } from "vite-plus/test";

import {
  makeDevelopmentEnvironmentScript,
  makeDevelopmentLauncherScript,
  resolveElectronBinaryPath,
  resolveMacBundleInfoPlistStrings,
  resolveMacCodeSignArguments,
  resolveMacLauncherIconPaths,
  resolveMacLauncherPaths,
  writeDevelopmentLauncherScript,
} from "./electron-launcher.mjs";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone script tests select the host executable format.
const hostPlatform = NodeOS.platform();

async function verifyDesktopChildStop(signal) {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-child-stop-"));
  const scripts = NodePath.join(directory, "scripts");
  NodeFS.mkdirSync(scripts);
  const marker = NodePath.join(directory, "graceful-child-stop");
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
    `export const desktopDir=${JSON.stringify(directory)};export function resolveElectronLaunchCommand(){return {electronPath:${JSON.stringify(process.execPath)},args:[${JSON.stringify(childPath)}]}}`,
  );
  const wrapper = NodeChildProcess.spawn(
    process.execPath,
    [NodePath.join(scripts, "start-electron.mjs")],
    { stdio: ["ignore", "pipe", "pipe"] },
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
      const deadline = setTimeout(
        () => reject(new Error("Fixture child did not become ready")),
        5000,
      );
      let text = "";
      wrapper.stdout.on("data", (value) => {
        text += value;
        if (text.includes("\n")) {
          clearTimeout(deadline);
          resolve(JSON.parse(text).pid);
        }
      });
    });
    wrapper.kill(signal);
    let deadline;
    const result = await Promise.race([
      exited,
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error("Desktop wrapper did not stop")), 5000);
      }),
    ]).finally(() => clearTimeout(deadline));
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

  it("declares why the macOS app needs protected access", () => {
    const values = resolveMacBundleInfoPlistStrings("T3 Code (Dev) Launcher");

    assert.equal(
      values.NSScreenCaptureUsageDescription,
      "T3 Code captures the active window when you use the snapshot shortcut.",
    );
    assert.equal(
      values.NSDocumentsFolderUsageDescription,
      "T3 Code reads project files you open in the desktop app.",
    );
  });

  it("ad-hoc signs the complete development app bundle", () => {
    assert.deepEqual(resolveMacCodeSignArguments("/runtime/T3 Code (Dev).app"), [
      "--force",
      "--deep",
      "--sign",
      "-",
      "--timestamp=none",
      "/runtime/T3 Code (Dev).app",
    ]);
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

  it("derives launcher icons from canonical development and production assets", () => {
    const development = resolveMacLauncherIconPaths("/runtime", true);
    const production = resolveMacLauncherIconPaths("/runtime", false);

    assert.match(development.sourceIconPath, /assets[\\/]dev[\\/]blueprint-macos-1024\.png$/);
    assert.equal(development.generatedIconPath, "/runtime/icon-dev.icns");
    assert.match(production.sourceIconPath, /assets[\\/]prod[\\/]black-macos-1024\.png$/);
    assert.equal(production.generatedIconPath, "/runtime/icon-prod.icns");
  });
});
