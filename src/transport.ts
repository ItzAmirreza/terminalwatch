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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type CaptureResult = { status: number; stdout: string; stderr: string };

export interface Transport {
  /** True if commands execute on the same kernel as the operator. */
  isLocal(): boolean;
  /** Short label for UI ("local" or "user@host"). */
  label(): string;
  /**
   * Run a command, wait for exit, capture stdout/stderr. This BLOCKS the
   * event loop for the whole round-trip, so only call it from flows that
   * are already synchronous and off the render path (e.g. the fd filter's
   * readlink fallback, which runs while the TUI is suspended).
   */
  execCapture(argv: string[]): CaptureResult;
  /**
   * Non-blocking sibling of execCapture. Prefer this from anything that
   * runs while the TUI is live (session refresh, history): a blocking
   * spawnSync would stall the OpenTUI redraw for the full SSH round-trip.
   */
  execCaptureAsync(argv: string[]): Promise<CaptureResult>;
  /** Spawn a long-running command, return the child for piping. */
  spawnPipe(argv: string[], opts?: SpawnOptions): ChildProcess;
  /** Tear down any persistent state (e.g. the SSH ControlMaster). */
  close(): void;
}

// Collect stdout/stderr from an already-spawned child into a CaptureResult.
function captureChild(child: ChildProcess): Promise<CaptureResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (e) => resolve({ status: -1, stdout, stderr: stderr || String(e) }));
    child.on("close", (code) => resolve({ status: code ?? -1, stdout, stderr }));
  });
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
  execCaptureAsync(argv: string[]): Promise<CaptureResult> {
    const [cmd, ...args] = argv;
    if (!cmd) return Promise.resolve({ status: -1, stdout: "", stderr: "empty argv" });
    return captureChild(spawn(cmd, args));
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
  private readonly dir: string;
  private readonly target: string;
  private readonly extra: string[];
  private opened = false;
  private cleaned = false;

  constructor(opts: SshOpts) {
    // A destination beginning with "-" would be swallowed by ssh's own
    // option parser (e.g. "-oProxyCommand=…"), turning an untrusted host
    // string into arbitrary ssh options / command execution. Refuse it.
    if (opts.target.startsWith("-")) {
      throw new Error(`refusing ssh destination that looks like a flag: "${opts.target}"`);
    }
    this.target = opts.target;
    this.extra = opts.extraArgs;
    this.dir = mkdtempSync(join(tmpdir(), "twatch-ssh-"));
    this.socket = join(this.dir, "ctl.sock");
    // Backstop: if the process dies without a clean close() (crash,
    // SIGKILL), at least remove the temp dir holding the control socket.
    // rmSync is synchronous so it is safe inside an 'exit' handler.
    process.once("exit", () => this.removeDir());
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

  execCaptureAsync(argv: string[]): Promise<CaptureResult> {
    if (!this.opened) {
      // open() is a one-time synchronous handshake; if it fails, surface
      // that as a failed capture rather than rejecting the promise.
      try {
        this.open();
      } catch (e: any) {
        return Promise.resolve({ status: -1, stdout: "", stderr: String(e?.message ?? e) });
      }
    }
    const remote = quoteForRemoteShell(argv);
    const sshArgs = ["-S", this.socket, ...this.extra, this.target, "--", remote];
    return captureChild(spawn("ssh", sshArgs));
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
    if (this.opened) {
      spawnSync("ssh", ["-S", this.socket, "-O", "exit", ...this.extra, this.target], {
        encoding: "utf8",
        stdio: "ignore",
      });
      this.opened = false;
    }
    this.removeDir();
  }

  private removeDir() {
    if (this.cleaned) return;
    this.cleaned = true;
    try { rmSync(this.dir, { recursive: true, force: true }); } catch {}
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
