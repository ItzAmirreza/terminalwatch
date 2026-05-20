# twatch — terminal watch

A sysadmin TUI for Linux: list every logged-in PTY session on the host
and live-mirror what any user is seeing on their terminal — keystrokes,
output, full-screen apps like `vim` or `top`, all of it.

```
┌─ twatch ─ azureuser@vps ─ 3 watchable sessions ─────────────────────────────┐
│ USER        TTY    FROM             LOCATION         LOGIN           DOING  │
│ azureuser   pts/0  77.119.164.236   Tehran, IR       20:35           bash   │
│ alice       pts/2  10.0.0.7         local            20:40           vim    │
│ deploy      pts/3  3.121.4.18       Frankfurt, DE    20:42           apt    │
└─────────────────────────────────────────────────────────────────────────────┘
  ↑/↓ move · Enter watch · r refresh · q quit
```

## Install

On a fresh Ubuntu / Debian box, one line:

```bash
curl -fsSL https://raw.githubusercontent.com/YOUR_GH_USER/terminalwatch/main/install.sh | bash
```

That installs `bun`, `strace`, and `unzip` if missing, drops the source
into `~/.local/share/twatch`, and writes a `/usr/local/bin/twatch`
launcher so the command is immediately on `$PATH`.

Or, from a checkout:

```bash
git clone https://github.com/YOUR_GH_USER/terminalwatch.git
cd terminalwatch && ./install.sh
```

> Replace `YOUR_GH_USER` with the actual GitHub user/org once the repo
> is pushed. Override via `TWATCH_REPO=https://… bash install.sh`.

## Use

```bash
twatch
```

- **↑ / ↓** — move the cursor
- **Enter** — attach to the highlighted session
- **r** — re-scan for new logins
- **q** / **Esc** — quit
- **← / Esc** (while attached) — detach back to the list
- **Ctrl+C** (while attached) — same as detach

Before the live stream starts you get a one-screen preamble: login
time, IP geolocation, and the tail of the target's `~/.bash_history` so
you have context for what they were doing before you joined.

You don't need to start `twatch` with `sudo` — it self-elevates via
`sudo strace` when you attach. Passwordless sudo makes it transparent;
otherwise sudo will prompt the first time per session.

## How it works

```
your terminal                       target user's terminal
   │                                       ▲
   │ replays ANSI bytes                    │ apps write here
   ▼                                       │
twatch ◀── decode ── strace -f -p <shell> ─┘
            ▲
            └─ filters writes whose fd actually points at the target's pts
```

1. `who` lists every active PTY; `ps -e -o pid,tty,stat,comm` finds the
   session leader (login shell) and current foreground process for each
   one. Works for any user on default Ubuntu (`/proc` is world-listable).
2. On Enter we `sudo strace -f -p <shellPid> -e trace=write -s 65535`,
   then for every `write(fd, "…", n)` line we resolve `/proc/PID/fd/N`
   and only forward writes whose destination is the target's `/dev/pts/X`.
   This is essential because `strace -f` follows children, and programs
   like `apt update` spawn helpers that write to pipes — without the
   filter you get pages of gpgv / apt-helper internal IPC noise.
3. Ubuntu's default `sudo use_pty` adds a wrinkle: `sudo` allocates an
   inner pty for its child and relays output through a monitor process
   that writes to `/dev/tty` (its real ctty being `/dev/pts/0`). We
   decode each writing process's controlling terminal from
   `/proc/PID/stat` field 7 so those relayed bytes still pass the filter.
4. We never forward your keystrokes back to the target. Watching is
   strictly passive.

## Limitations / notes

- **Linux only.** Relies on `/proc`, `strace`, and the Linux pts model.
  On macOS / BSD the binary will refuse to start the watch path; the
  UI still runs in `--mock` mode for demos.
- **Needs root to attach** (`ptrace_scope=1` on default Ubuntu blocks
  cross-UID ptrace). The launcher invokes `sudo strace`, so the user
  running `twatch` needs sudo rights.
- **`~/.bash_history` is only flushed on shell exit** by default. The
  preamble shows commands from previous bash sessions, not necessarily
  what the target typed during the *current* session.
- **Terminal size mismatch**: full-screen apps render to the target's
  reported terminal size. If your terminal is smaller, lines may wrap.
  Make your window at least as wide/tall as theirs.
- **No keystroke injection.** Detach (← / Esc) returns to the list.

## Dev

```bash
bun install
bun run dev:mock     # UI on macOS / non-Linux, mock data
bun run dev          # real listing (Linux only)
bun run typecheck
```

`src/test-capture.ts` and `src/test-diag.ts` are non-interactive
harnesses used to validate the filter against real workloads
(`sudo apt-get update`, etc.).

## Roadmap

- Remote mode: run `twatch` on your laptop, target a remote VPS over
  SSH (`twatch --remote azureuser@host`). The plumbing is the same; the
  spawn target moves to the other side.
- Optional vt-renderer so the watch view stays inside the TUI (instead
  of taking over the whole terminal), enabling split-view and side-by-
  side comparisons.
- Audit log: append timestamped session metadata for every attach so
  there's a record of who watched whom and when.
