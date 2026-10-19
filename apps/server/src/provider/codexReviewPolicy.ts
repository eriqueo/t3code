import { REVIEW_MODEL_ID } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const CODEX_REVIEW_MODEL = REVIEW_MODEL_ID;
export const CODEX_REVIEW_NATIVE_VERSION = "codex-cli 0.163.0";
export const CODEX_REVIEW_NATIVE_FILES = {
  "bin/codex": "399ff69c431c066e40de318fba45c2b07f45a76b19939d247ee4828fc70c4215",
  "bin/codex-code-mode-host": "8724d73ec190536233ab4628d24a071bfbcf27e5124f08fe35129f26fe48b916",
  "codex-resources/bwrap": "77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c",
} as const;

/** The model requires the isolated V8 tool host; nested effects still use native sandbox checks. */
export const CODEX_REVIEW_FEATURES = {
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
} as const;

const absolutePath = Schema.String.check(Schema.isPattern(/^\/[^\r\n]+$/));
/** Startup-owned ports. These are never decoded from provider-instance settings. */
export const CodexReviewLaunchConfig = Schema.Struct({
  nativeDirectory: absolutePath.check(
    Schema.isPattern(/^\/nix\/store\/[^/]+(?:\/[^/]+)*$/),
    Schema.makeFilter((value) => value.split("/").every((part) => part !== "." && part !== "..")),
  ),
  pythonPath: absolutePath.check(Schema.isPattern(/^\S+$/)),
  mountPath: absolutePath,
  unsharePath: absolutePath,
  authSource: absolutePath,
  path: Schema.String.check(Schema.isPattern(/^[^\r\n]+$/)),
});
export type CodexReviewLaunchConfig = typeof CodexReviewLaunchConfig.Type;

const emptyRecord = Schema.Record(Schema.String, Schema.Unknown).check(
  Schema.makeFilter((value) => Object.keys(value).length === 0),
);
const emptyList = Schema.Array(Schema.Unknown).check(
  Schema.makeFilter((value) => value.length === 0),
);

export const reviewEffectiveConfigSchema = (homePath: string) =>
  Schema.Struct({
    config: Schema.Struct({
      approval_policy: Schema.Literal("never"),
      sandbox_mode: Schema.Literal("read-only"),
      web_search: Schema.Literal("disabled"),
      cli_auth_credentials_store: Schema.Literal("file"),
      allow_login_shell: Schema.Literal(false),
      model_provider: Schema.NullOr(Schema.Literal("openai")),
      default_permissions: Schema.Null,
      permissions: Schema.Null,
      profile: Schema.Null,
      profiles: emptyRecord,
      mcp_servers: emptyRecord,
      agents: Schema.Struct({ enabled: Schema.Literal(false) }),
      apps: Schema.Record(Schema.String, Schema.Struct({ enabled: Schema.Literal(false) })),
      features: Schema.Struct(
        Object.fromEntries(
          Object.entries(CODEX_REVIEW_FEATURES).map(([key, value]) => [key, Schema.Literal(value)]),
        ),
      ),
    }),
    layers: Schema.Array(
      Schema.Struct({
        name: Schema.Union([
          Schema.Struct({ type: Schema.Literal("sessionFlags") }),
          Schema.Struct({
            type: Schema.Literal("user"),
            file: Schema.Literal(`${homePath}/config.toml`),
          }),
          Schema.Struct({
            type: Schema.Literal("system"),
            file: Schema.Literal("/etc/codex/config.toml"),
          }),
        ]),
      }),
    ),
  });

export const ReviewRequirements = Schema.Struct({ requirements: Schema.Null });

export const reviewThreadReceiptSchema = (cwd: string) => {
  const roots = Schema.Array(Schema.Literal(cwd)).check(
    Schema.makeFilter((value) => value.length === 1),
  );
  return Schema.Struct({
    cwd: Schema.Literal(cwd),
    model: Schema.Literal(CODEX_REVIEW_MODEL),
    approvalPolicy: Schema.Literal("never"),
    sandbox: Schema.Struct({
      type: Schema.Literal("readOnly"),
      networkAccess: Schema.Literal(false),
    }),
    activePermissionProfile: Schema.Null,
    runtimeWorkspaceRoots: roots,
    instructionSources: emptyList,
    thread: Schema.Struct({
      environments: Schema.Array(
        Schema.Struct({
          environmentId: Schema.Literal("local"),
          cwd: Schema.Literal(cwd),
          runtimeWorkspaceRoots: roots,
        }),
      ).check(Schema.makeFilter((value) => value.length === 1)),
    }),
  });
};

export const reviewLaunchSpec = (config: CodexReviewLaunchConfig, workspace: string) => {
  const settings = {
    approval_policy: "never",
    sandbox_mode: "read-only",
    web_search: "disabled",
    cli_auth_credentials_store: "file",
    allow_login_shell: false,
  } as const;
  const overrides = [
    ...Object.entries(settings).map(([key, value]) => `${key}=${JSON.stringify(value)}`),
    ...Object.entries(CODEX_REVIEW_FEATURES).map(([key, value]) => `features.${key}=${value}`),
    "agents.enabled=false",
    "apps._default.enabled=false",
    "mcp_servers={}",
  ];
  const policy = [
    ...Object.entries(settings).map(([key, value]) => `${key}=${JSON.stringify(value)}`),
    "[features]",
    ...Object.entries(CODEX_REVIEW_FEATURES).map(([key, value]) => `${key}=${value}`),
    "[agents]",
    "enabled=false",
    "[apps._default]",
    "enabled=false",
    "[mcp_servers]",
    "",
  ].join("\n");
  return {
    nativeBinary: `${config.nativeDirectory}/bin/codex`,
    nativeSha256: CODEX_REVIEW_NATIVE_FILES["bin/codex"],
    nativeVersion: CODEX_REVIEW_NATIVE_VERSION,
    nativeFiles: Object.entries(CODEX_REVIEW_NATIVE_FILES).map(([relative, sha256]) => ({
      path: `${config.nativeDirectory}/${relative}`,
      sha256,
    })),
    workspace,
    python: config.pythonPath,
    mount: config.mountPath,
    unshare: config.unsharePath,
    authSource: config.authSource,
    path: config.path,
    overrides,
    policy,
  };
};

/** Executed only with a startup-owned launch spec and an owned disposable workspace. */
export const CODEX_REVIEW_LAUNCH_SCRIPT = String.raw`#!/usr/bin/env python3
"""Internal Review launcher. Its spec comes from the server, never provider settings."""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

PUBLIC_ETC = ('resolv.conf', 'nsswitch.conf', 'hosts', 'ssl/certs/ca-certificates.crt')
MANAGED_FILES = ('requirements.toml', 'managed_config.toml')


def require(value, code):
    if not value:
        raise RuntimeError(code)


def main():
    require(sys.platform == 'linux', 'linux-required')
    spec = json.loads(os.environ['T3_REVIEW_LAUNCH_SPEC'])
    binary = Path(spec['nativeBinary'])
    require(binary.is_absolute() and str(binary.resolve()).startswith('/nix/store/'), 'immutable-native-required')
    for resource in spec['nativeFiles']:
        target = Path(resource['path'])
        require(str(target.resolve()).startswith('/nix/store/'), 'immutable-resource-required')
        with target.open('rb') as handle:
            require(hashlib.file_digest(handle, 'sha256').hexdigest() == resource['sha256'], 'native-resource-hash-mismatch')
    require(subprocess.check_output([str(binary), '--version'], timeout=5, text=True).strip() == spec['nativeVersion'], 'native-version-mismatch')
    private = Path(spec['workspace'])
    if sys.argv[1:] == ['app-server']:
        require(not private.is_symlink() and private.is_dir() and private.stat().st_uid == os.getuid(), 'invalid-owned-workspace')
        require(not list(private.iterdir()), 'workspace-not-empty')
        require(not any(os.path.lexists(Path('/etc/codex') / name) for name in MANAGED_FILES), 'managed-policy-unsupported')
        env = dict(os.environ)
        env['T3_REVIEW_PARENT_MOUNT_NAMESPACE'] = os.readlink('/proc/self/ns/mnt')
        os.execve(spec['unshare'], [spec['unshare'], '--user', '--map-current-user', '--keep-caps', '--mount', '--pid', '--mount-proc', '--propagation', 'private', '--fork', '--kill-child', spec['python'], __file__, '--namespace'], env)
    require(sys.argv[1:] == ['--namespace'], 'unexpected-launch-arguments')
    require(os.getpid() == 1, 'private-pid-namespace-required')
    require(os.readlink('/proc/self/ns/mnt') != os.environ['T3_REVIEW_PARENT_MOUNT_NAMESPACE'], 'private-mount-namespace-required')

    def mount(*args):
        subprocess.run([spec['mount'], '--no-mtab', *args], check=True, timeout=5, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    mount('--make-rprivate', '/')
    mount('-t', 'tmpfs', '-o', 'mode=0700,size=128m,nosuid,nodev', 'tmpfs', str(private))
    home, codex, neutral, etc = private / 'home', private / 'home/codex', private / 'neutral', private / 'etc'
    for directory in (codex, neutral / '.git', private / 'tmp', etc):
        directory.mkdir(parents=True, exist_ok=True)
    for name in PUBLIC_ETC:
        target = etc / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(Path('/etc') / name, target)
        target.chmod(0o444)
    (etc / 'passwd').write_text(f'review:x:{os.getuid()}:{os.getgid()}:Review:{home}:/bin/sh\n')
    (etc / 'group').write_text(f'review:x:{os.getgid()}:\n')
    policy = codex / 'config.toml'
    policy.write_text(spec['policy'])
    policy.chmod(0o444)
    # Copy only this account credential into ephemeral storage. Never modify its owner.
    if spec.get('authSource'):
        source = Path(spec['authSource'])
        require(source.is_file() and source.stat().st_uid == os.getuid() and source.stat().st_size <= 1024 * 1024, 'auth-source-unavailable')
        auth = codex / 'auth.json'
        auth.write_bytes(source.read_bytes())
        auth.chmod(0o600)
    mount('--bind', str(etc), '/etc')
    mount('-o', 'remount,bind,ro', '/etc')
    for target in (policy, neutral):
        mount('--bind', str(target), str(target))
        mount('-o', 'remount,bind,ro', str(target))
    class Header(ctypes.Structure):
        _fields_ = [('version', ctypes.c_uint32), ('pid', ctypes.c_int)]
    class Data(ctypes.Structure):
        _fields_ = [('effective', ctypes.c_uint32), ('permitted', ctypes.c_uint32), ('inheritable', ctypes.c_uint32)]
    libc = ctypes.CDLL(None, use_errno=True)
    require(libc.prctl(47, 4, 0, 0, 0) == 0, 'ambient-capability-drop-failed')
    header, data = Header(0x20080522, 0), (Data * 2)()
    require(libc.capset(ctypes.byref(header), ctypes.byref(data)) == 0, 'capability-drop-failed')
    require(libc.prctl(38, 1, 0, 0, 0) == 0, 'no-new-privileges-failed')
    os.chdir(neutral)
    # Explicit environment excludes T3 MCP/device credentials and host configuration.
    env = {'HOME': str(home), 'CODEX_HOME': str(codex), 'TMPDIR': str(private / 'tmp'),
           'XDG_CONFIG_HOME': str(home / 'config'), 'XDG_CACHE_HOME': str(home / 'cache'),
           'XDG_DATA_HOME': str(home / 'data'), 'SSL_CERT_FILE': '/etc/ssl/certs/ca-certificates.crt',
           'PATH': spec['path'], 'LANG': 'C.UTF-8'}
    args = [str(binary), 'app-server', '--listen', 'stdio://', '--strict-config']
    for override in spec['overrides']:
        args += ['-c', override]
    os.execve(str(binary), args, env)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Deliberately omit exception payloads, paths, config and credentials.
        code = str(error) if type(error) is RuntimeError else type(error).__name__
        print('Review launch refused: ' + code, file=sys.stderr)
        raise SystemExit(1)
`;
