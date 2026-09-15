# Terminal history

Each terminal keeps up to 5,000 lines and 8 MiB of scrollback on its environment
server. T3 Code removes the oldest output when either limit is reached. A long
line can be shortened at the start. New terminal output is not truncated.

These limits apply when you reconnect and when T3 Code restores saved terminal
history. A client can show less scrollback than the server keeps.

## Test command receipts

Use the T3 CLI to run an explicit command in a thread's workspace and save its exit result:

```sh
t3 test-run run '{"version":1,"requestId":"tests-unique-1","threadId":"YOUR_THREAD_ID","command":"npm","args":["test"],"timeoutSeconds":600}'
t3 test-run get '{"requestId":"tests-unique-1"}'
```

The server must be running. Execution requires terminal-operation permission. Arguments
are passed directly to the program. Reusing the same request ID retrieves its receipt;
it never reruns the command. Use a new ID for a deliberate new execution. If the connection
drops, retrieve the receipt before deciding what to do next.

Receipts include the exact command, exit code, and before/after workspace fingerprints.
Exit zero only means the program exited zero. Matching observations do not prove that
files stayed unchanged during execution or that the workspace still matches now.
Fingerprints cover tracked and nonignored untracked working-tree files, including file
modes and symlink target names, not target contents. Ignored dependencies, runtime state, and Git internals are
outside the content fingerprint. Submodule directories are unsupported. No command output
or file contents are saved in the receipt. Arguments are saved, so do not put secrets in them.
The command inherits the server environment. The receipt records its initial working directory;
it does not confine the command or prove which files its tests used.

The runner allows four active requests per server and one per checkout; excess requests
are rejected. Commands have a ten-minute maximum. Each fingerprint has a one-minute limit,
100,000-file limit, 512 MiB total limit, and 32 MiB per-file limit. If the initial fingerprint
cannot be collected, the command does not start.

An `outcome_unknown` receipt keeps its checkout slot occupied. It never triggers a retry.
Inspect the process and its effects. Only after confirming the process has stopped, release
the slot with terminal-operation permission:

```sh
t3 test-run release '{"requestId":"tests-unique-1","processStopped":true}'
```

Release records who confirmed the stop and preserves the uncertain result. After a server
crash, a stranded running receipt becomes unknown when its deadline passes. These receipts
are available through the CLI and HTTP API. Preparing Start fresh also attaches summaries
of up to three recent receipts from the source thread. The attachment keeps exit results
and historical fingerprints, omits arguments, and reports whether older receipts were
omitted. Retrieve full records by request ID when needed. A collection failure is shown
as unavailable evidence. Current validity remains unknown; a matching path does not prove
matching contents. Preparing or consuming a handoff never runs these commands again.

Start fresh also includes an observation of the collecting T3 backend: loaded package
version, Node version, PID, uptime, platform and architecture. On Linux it reads the boot
ID and the NixOS running, booted and default next-boot profile paths. Missing, malformed,
changing or unsupported values are marked unavailable. Collection has a two-second limit.

This describes the backend's filesystem namespace at preparation time. Package version
does not identify the exact source revision, and profile paths do not prove bootloader
selection, successful activation or application health. Application-service health and DX2
execution checks are not included. Recheck current state before acting on the receipt.
