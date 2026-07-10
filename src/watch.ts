// Live PTY mirror for a target session.
//
// Strategy: spawn `sudo strace -f -p <shellPid> -e trace=write
// -e signal=none -s 65535 -qq`, parse each emitted line, and for any
// `write(1, "...", N)` or `write(2, "...", N)` decode the C-escaped bytes
// and pipe them straight to our stdout.
//
// Critical: strace -f traces children too, so commands like `apt update`
// surface write()s from helper procs (gpgv, apt-helper) that go to pipes
// between cooperating processes — NOT to the user's terminal. We resolve
// /proc/PID/fd/N for each (pid, fd) we see and only forward writes whose
// fd actually points at the target session's pts.
//
// We deliberately do NOT forward keystrokes back to the target — passive
// observation only. Left Arrow or Esc detaches.

import { type ChildProcess } from "node:child_process";
import { decodeCEscaped, findCloseQuote } from "./cescape.ts";
import { FdResolver } from "./fdfilter.ts";
import type { Transport } from "./transport.ts";

export type WatchHandle = {
  detach: () => void;
  done: Promise<{ reason: "user" | "exit" | "error"; code?: number; err?: string }>;
};

export type WatchOptions = {
  // Where the target lives (local or SSH).
  transport: Transport;
  shellPid: number;
  // Path like "/dev/pts/0" — used to filter strace writes to actual tty
  // output (vs. pipe writes from helper procs).
  targetPts: string;
  // When true, run strace under sudo. On hosts where the watcher already
  // runs as root, set false to skip the sudo invocation.
  useSudo?: boolean;
  // Optional preamble to print before the live stream starts (e.g. history).
  preamble?: string;
  // For local mock/dev: instead of strace, replay a canned stream.
  mockStream?: AsyncIterable<Uint8Array>;
};

export function startWatch(opts: WatchOptions): WatchHandle {
  const out = process.stdout;
  let detached = false;
  let resolve!: (v: { reason: "user" | "exit" | "error"; code?: number; err?: string }) => void;
  const done = new Promise<{ reason: "user" | "exit" | "error"; code?: number; err?: string }>(
    (r) => (resolve = r),
  );

  out.write("\x1b[2J\x1b[H");
  if (opts.preamble) out.write(opts.preamble);
  out.write(
    `\x1b[7m  twatch ▸ attached to pid ${opts.shellPid} on ${opts.targetPts}  ·  ← or Esc to detach  \x1b[0m\r\n`,
  );

  let child: ChildProcess | null = null;
  let mockAbort: AbortController | null = null;
  const resolver = opts.mockStream
    ? null
    : new FdResolver(opts.targetPts, opts.transport, opts.useSudo !== false);

  if (opts.mockStream) {
    mockAbort = new AbortController();
    void (async () => {
      try {
        for await (const chunk of opts.mockStream!) {
          if (mockAbort!.signal.aborted) break;
          out.write(chunk);
        }
        if (!detached) finish({ reason: "exit", code: 0 });
      } catch (e: any) {
        if (!detached) finish({ reason: "error", err: String(e?.message ?? e) });
      }
    })();
  } else {
    const straceArgs = [
      "-f",
      "-y",                  // decode fd→path inline: `write(1</dev/pts/0>, …)`
      "-p", String(opts.shellPid),
      "-e", "trace=write",
      "-e", "signal=none",
      // Cap on how much of each write()'s buffer strace prints. 1 MiB is far
      // above any realistic single tty write (the pty line-discipline buffer
      // is tens of KiB), so terminal output is captured whole; only a single
      // write() larger than this would lose its tail.
      "-s", "1048576",
      "-qq",
    ];
    const argv = opts.useSudo === false
      ? ["strace", ...straceArgs]
      : ["sudo", "-n", "strace", ...straceArgs];
    child = opts.transport.spawnPipe(argv, { stdio: ["ignore", "ignore", "pipe"] });

    const parser = new StraceLineParser(
      opts.shellPid,
      resolver!,
      (bytes) => out.write(bytes),
      (errLine, fatal) => {
        out.write(`\x1b[31m${errLine}\x1b[0m\r\n`);
        // A fatal diagnostic (sudo auth failure, ptrace EPERM, …) means no
        // output is ever coming. Tear down and surface it as an error so the
        // session screen shows a message — otherwise the operator stares at a
        // blank mirror: locally the child would exit silently, and over SSH
        // the wrapper's `cat > /dev/null` would keep the channel open forever.
        if (fatal && !detached) finish({ reason: "error", err: errLine.replace(/\s+/g, " ").trim() });
      },
    );
    child.stderr!.on("data", (buf: Buffer) => parser.feed(buf));
    child.on("exit", (code) => {
      if (detached) return;
      // A clean detach kills the child ourselves (sets detached first), so
      // reaching here means strace/sudo died on its own. Non-zero is a
      // failure (sudo denied, ptrace refused); 0 is the traced shell exiting.
      if (code && code !== 0) finish({ reason: "error", err: `strace exited with status ${code}` });
      else finish({ reason: "exit", code: code ?? 0 });
    });
    child.on("error", (err) => {
      if (!detached) finish({ reason: "error", err: err.message });
    });
  }

  // Watch our stdin for the detach keys.
  const stdin = process.stdin;
  const wasRaw = stdin.isTTY ? stdin.isRaw : false;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  const detachDetector = new DetachDetector(() => finish({ reason: "user" }));
  const onData = (buf: Buffer) => detachDetector.feed(buf);
  stdin.on("data", onData);

  async function finish(r: { reason: "user" | "exit" | "error"; code?: number; err?: string }) {
    if (detached) return;
    detached = true;
    stdin.removeListener("data", onData);
    detachDetector.dispose();
    if (stdin.isTTY) stdin.setRawMode(wasRaw);
    if (mockAbort) mockAbort.abort();

    // Graceful shutdown of the spawned child (especially important for
    // SshTransport): close stdin first so the remote wrapper's
    // `cat > /dev/null` hits EOF and runs its cleanup (kill strace,
    // wait for it to detach, exit). The local ssh then exits naturally
    // after the remote does, so `child.exit` fires only AFTER the
    // remote ptrace tracer is gone. Without this, an immediate
    // re-attach against the same target PID hits EPERM because the
    // previous strace is still attached.
    if (child) {
      try { child.stdin?.end(); } catch {}
      // A LOCAL strace has no remote wrapper watching stdin, so closing it
      // above does nothing — signal the tracer directly and immediately.
      // strace detaches from the target on SIGTERM; a later SIGKILL is also
      // safe because the kernel auto-detaches ptrace when the tracer dies.
      // This closes the ~1.5s window where the old strace is still attached
      // and an immediate re-attach to the same PID could race on EPERM.
      if (opts.transport.isLocal()) {
        try { child.kill("SIGTERM"); } catch {}
      }
      await new Promise<void>((res) => {
        if (child!.exitCode !== null || child!.signalCode !== null) return res();
        let done = false;
        const finishOnce = () => { if (!done) { done = true; res(); } };
        child!.once("exit", finishOnce);
        // Escalate if the wrapper doesn't tear down on its own. 1.5s
        // is comfortably more than a clean detach roundtrip even on
        // sluggish links; SIGKILL at 3s; absolute give-up at 5s so a
        // dead-network host can't pin the UI forever.
        setTimeout(() => { if (!done && child && !child.killed) { try { child.kill("SIGTERM"); } catch {} } }, 1500);
        setTimeout(() => { if (!done && child && !child.killed) { try { child.kill("SIGKILL"); } catch {} } }, 3000);
        setTimeout(finishOnce, 5000);
      });
    }
    resolve(r);
  }

  return {
    detach: () => finish({ reason: "user" }),
    done,
  };
}

// Detect detach intent from raw stdin bytes:
//   - Left Arrow: ESC [ D  (normal mode)  or  ESC O D  (application mode)
//   - Esc (bare): ESC with no continuation
//   - Ctrl+C:    0x03
//   - Ctrl+]:    0x1d  (legacy from v1)
//
// A lone trailing ESC is ambiguous: it can be a real Esc press OR the first
// byte of an escape sequence (arrow / F-key) that got split across two stdin
// reads. So when a buffer ends in a bare ESC we don't decide immediately — we
// wait a short grace period. If a continuation arrives first it's a sequence;
// if the timer fires first it was a real Esc. This kills the spurious detach
// that fired when an arrow-key sequence happened to split on the ESC boundary.
export class DetachDetector {
  private pendingEsc = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onDetach: () => void,
    private readonly escGraceMs = 50,
  ) {}

  feed(buf: Buffer): void {
    let i = 0;
    if (this.pendingEsc) {
      this.clearTimer();
      this.pendingEsc = false;
      const b0 = buf[0];
      if (b0 === 0x5b || b0 === 0x4f) {
        // Continuation of a CSI/SS3 sequence begun by the pending ESC.
        if (buf[1] === 0x44) return this.onDetach(); // ESC [ D / ESC O D = left arrow
        // Skip to the sequence's final byte, then scan the remainder normally.
        i = 1;
        while (i < buf.length) {
          const c = buf[i]!;
          i++;
          if (c >= 0x40 && c <= 0x7e) break;
        }
      } else {
        // Nothing continued the ESC → it was a real Esc press.
        return this.onDetach();
      }
    }
    for (; i < buf.length; i++) {
      const b = buf[i]!;
      if (b === 0x03 || b === 0x1d) return this.onDetach();
      if (b === 0x1b) {
        const next = buf[i + 1];
        const after = buf[i + 2];
        // Left arrow: ESC [ D  or  ESC O D
        if ((next === 0x5b || next === 0x4f) && after === 0x44) return this.onDetach();
        // Bare Esc at the end of this buffer — defer the decision.
        if (next === undefined) { this.armPending(); return; }
        // Some other escape sequence (cursor up/down, F-keys) — skip it.
        i += 1;
        while (i < buf.length - 1) {
          const c = buf[i + 1]!;
          if (c >= 0x40 && c <= 0x7e) { i++; break; } // final byte of CSI
          i++;
        }
      }
    }
  }

  // Clear any pending timer so a deferred Esc can't fire after detach.
  dispose(): void {
    this.clearTimer();
    this.pendingEsc = false;
  }

  private armPending(): void {
    this.pendingEsc = true;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.pendingEsc) { this.pendingEsc = false; this.onDetach(); }
    }, this.escGraceMs);
  }

  private clearTimer(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}

// Under -qq strace suppresses "Process N attached/detached" and "+++ exited"
// notices, so a `strace: …` line is almost always a hard error (ptrace
// EPERM, "Operation not permitted", no such process). Treat the rare
// attach/detach notice that still slips through as non-fatal.
function isFatalStraceLine(line: string): boolean {
  return !/attached|detached/i.test(line);
}

// Incremental parser for strace stderr. strace writes line-buffered output;
// we split on \n and pick out `write(1|2, "...", N)`.
export class StraceLineParser {
  private buf = "";
  constructor(
    private readonly attachedPid: number,
    private readonly resolver: FdResolver,
    private readonly onBytes: (bytes: Uint8Array) => void,
    private readonly onError?: (line: string, fatal: boolean) => void,
  ) {}
  feed(chunk: Buffer) {
    this.buf += chunk.toString("binary");
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      this.handleLine(line);
    }
  }
  private handleLine(line: string) {
    let i = 0;
    let pid = this.attachedPid;
    if (line.startsWith("[pid")) {
      const close = line.indexOf("]", 4);
      if (close < 0) return;
      pid = parseInt(line.slice(4, close).trim(), 10);
      i = close + 1;
      while (i < line.length && line.charCodeAt(i) === 0x20) i++;
    }
    if (!line.startsWith("write(", i)) {
      // Surface diagnostics from the wrapped command. `sudo: …` (e.g. "a
      // password is required", "a terminal is required") is always fatal:
      // no capture will ever start. `strace: …` under -qq is likewise an
      // error (attach/detach/exit chatter is suppressed), except the benign
      // attach/detach notices that can still slip through.
      if (this.onError) {
        if (line.startsWith("sudo:")) this.onError(line, true);
        else if (line.startsWith("strace:")) this.onError(line, isFatalStraceLine(line));
      }
      return;
    }
    i += "write(".length;
    const comma = line.indexOf(",", i);
    if (comma < 0) return;

    // With strace -y the fd is rendered as `N<path>`. Extract both the
    // integer fd and the inline path so we don't have to readlink
    // /proc/PID/fd/N over SSH — that race was losing all output from
    // short-lived processes (cat, ls, echo …) which had exited by the
    // time the readlink reached the box.
    let fdEnd = i;
    while (fdEnd < comma && line.charCodeAt(fdEnd) >= 0x30 && line.charCodeAt(fdEnd) <= 0x39) fdEnd++;
    const fd = parseInt(line.slice(i, fdEnd), 10);
    let knownLink: string | undefined;
    if (line.charCodeAt(fdEnd) === 0x3c /* < */) {
      const lt = fdEnd + 1;
      const gt = line.indexOf(">", lt);
      if (gt > lt && gt < comma) knownLink = line.slice(lt, gt);
    }

    // Don't filter on fd number — sudo's I/O monitor relays via fd 8
    // (its dup of /dev/tty), not fd 1/2. The link-based check is what
    // decides whether this write is actually user-visible.
    if (!this.resolver.isTargetTty(pid, fd, knownLink)) return;
    let j = comma + 1;
    while (j < line.length && line.charCodeAt(j) === 0x20) j++;
    if (line.charCodeAt(j) !== 0x22 /* " */) return;
    const close = findCloseQuote(line, j + 1);
    if (close < 0) return;
    const escaped = line.slice(j + 1, close);
    const bytes = decodeCEscaped(escaped);
    this.onBytes(bytes);
  }
}

// Demo / mock stream useful when developing the UI on a Mac.
export async function* demoMockStream(): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder();
  yield enc.encode("\x1b[2J\x1b[H");
  yield enc.encode("user@vps:~$ ");
  for (const ch of "ls -la /var/log\n") {
    await sleep(60);
    yield enc.encode(ch);
  }
  await sleep(150);
  yield enc.encode("total 1248\n");
  yield enc.encode("drwxr-xr-x  9 root root  4096 May 20 20:30 .\n");
  yield enc.encode("drwxr-xr-x 14 root root  4096 May 20 19:11 ..\n");
  yield enc.encode("-rw-r-----  1 syslog adm  62k May 20 20:35 syslog\n");
  yield enc.encode("user@vps:~$ ");
  for (const ch of "vim deploy.yml\n") {
    await sleep(70);
    yield enc.encode(ch);
  }
  await sleep(200);
  yield enc.encode("\x1b[?1049h\x1b[2J\x1b[H");
  yield enc.encode("\x1b[1;1H~\n~\n~\n~\n~ deploy.yml [New File]");
  await sleep(1200);
  yield enc.encode("\x1b[?1049l");
  yield enc.encode("\nuser@vps:~$ ");
  while (true) {
    await sleep(800);
    yield enc.encode(`echo "still here at ${new Date().toLocaleTimeString()}"\n`);
  }
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
