// Transport abstraction so the rest of the codebase doesn't care whether
// commands run on the local box or on a remote host over SSH. A Transport
// has two flavors:
//
//   - LocalTransport: spawn / spawnSync directly (today's behavior).
//
//   - SshTransport:  every call is multiplexed through one persistent
//                    SSH connection (OpenSSH ControlMaster). The first
//                    call pays the SSH handshake; subsequent calls reuse
//                    the socket and are sub-10ms. Crucial because we
//                    fire readlink/cat /proc many times during a watch.
//
// All commands the rest of the code wants to run are passed as
// (argv0, argv[]) — the transport handles quoting for SSH.

import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type CaptureResult = { status: number; stdout: string; stderr: string };

export interface Transport {
  /** True if commands execute on the same kernel as the operator. */
  isLocal(): boolean;
  /** Short label for UI ("local" or "user@host"). */
  label(): string;
  /** Run a command, wait for exit, capture stdout/stderr. */
  execCapture(argv: string[]): CaptureResult;
  /** Spawn a long-running command, return the child for piping. */
  spawnPipe(argv: string[], opts?: SpawnOptions): ChildProcess;
  /** Tear down any persistent state (e.g. the SSH ControlMaster). */
  close(): void;
}

export class LocalTransport implements Transport {
  isLocal() { return true; }
  label() { return "local"; }
  execCapture(argv: string[]): CaptureResult {
    const [cmd, ...args] = argv;
    if (!cmd) return { status: -1, stdout: "", stderr: "empty argv" };
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }
  spawnPipe(argv: string[], opts: SpawnOptions = {}): ChildProcess {
    const [cmd, ...args] = argv;
    if (!cmd) throw new Error("LocalTransport.spawnPipe: empty argv");
    return spawn(cmd, args, opts);
  }
  close() {}
}

export type SshOpts = {
  // ssh destination, e.g. "azureuser@host" or a Host alias from ~/.ssh/config.
  target: string;
  // Extra `ssh -i` / `-p` / `-o …` arguments inserted before the target on
  // every invocation.
  extraArgs: string[];
};

export class SshTransport implements Transport {
  private readonly socket: string;
  private readonly target: string;
  private readonly extra: string[];
  private opened = false;

  constructor(opts: SshOpts) {
    this.target = opts.target;
    this.extra = opts.extraArgs;
    const dir = mkdtempSync(join(tmpdir(), "twatch-ssh-"));
    this.socket = join(dir, "ctl.sock");
  }

  isLocal() { return false; }
  label() { return this.target; }

  /** Open the ControlMaster connection (idempotent). */
  open(): void {
    if (this.opened) return;
    const args = [
      "-o", "ControlMaster=yes",
      "-o", `ControlPath=${this.socket}`,
      "-o", "ControlPersist=600",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ServerAliveInterval=30",
      "-n", "-N", "-f",
      ...this.extra,
      this.target,
    ];
    const r = spawnSync("ssh", args, { encoding: "utf8" });
    if (r.status !== 0) {
      throw new Error(
        `ssh ControlMaster setup failed (status ${r.status}): ${r.stderr.trim() || r.stdout.trim() || "unknown error"}`,
      );
    }
    this.opened = true;
  }

  execCapture(argv: string[]): CaptureResult {
    if (!this.opened) this.open();
    const remote = quoteForRemoteShell(argv);
    const sshArgs = ["-S", this.socket, ...this.extra, this.target, "--", remote];
    const r = spawnSync("ssh", sshArgs, { encoding: "utf8" });
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  spawnPipe(argv: string[], opts: SpawnOptions = {}): ChildProcess {
    if (!this.opened) this.open();
    // Wrap the remote command so it dies cleanly when our local ssh
    // exits. Without this, `ssh host 'sudo -n strace -p PID'` leaves
    // an orphaned strace on the remote — local ssh dies, the strace
    // sees its stdin/stdout close, but it keeps running, still
    // attached as a ptrace tracer. The next attach attempt against
    // the same PID then fails with EPERM ("already traced by …").
    //
    // The pattern below runs the real command in the background and
    // blocks on `cat > /dev/null` reading from stdin. When ssh closes
    // the channel (because we killed the local ssh), the remote
    // stdin EOFs, cat exits, and the wrapper signals the bg command.
    const inner = quoteForRemoteShell(argv);
    const wrapped =
      `${inner} & __tw_pid=$!; ` +
      `cat > /dev/null; ` +
      `kill -TERM $__tw_pid 2>/dev/null; ` +
      `wait $__tw_pid 2>/dev/null`;
    const sshArgs = ["-S", this.socket, ...this.extra, this.target, "--", wrapped];

    // ssh's stdin must stay OPEN so the remote `cat > /dev/null` blocks
    // (otherwise the wrapper would EOF immediately and kill strace
    // before it could attach). Override stdio[0]="ignore" → "pipe".
    const stdio: any[] = Array.isArray(opts.stdio)
      ? [...opts.stdio]
      : opts.stdio
        ? [opts.stdio, opts.stdio, opts.stdio]
        : ["pipe", "pipe", "pipe"];
    if (stdio[0] === "ignore") stdio[0] = "pipe";
    return spawn("ssh", sshArgs, { ...opts, stdio: stdio as any });
  }

  close() {
    if (!this.opened) return;
    spawnSync("ssh", ["-S", this.socket, "-O", "exit", ...this.extra, this.target], {
      encoding: "utf8",
      stdio: "ignore",
    });
    this.opened = false;
  }
}

/**
 * Build a single shell-string from an argv that the remote shell will
 * receive as one argument after ssh's own argv parsing. Each token gets
 * POSIX single-quote escaping; the tokens are joined with spaces.
 */
function quoteForRemoteShell(argv: string[]): string {
  return argv.map(shellQuote).join(" ");
}

function shellQuote(s: string): string {
  if (s === "") return "''";
  // Anything that's purely safe doesn't need quoting.
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  // POSIX single-quote escape: close, escaped-quote, reopen.
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}
