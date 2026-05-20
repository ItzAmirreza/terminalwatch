import { createCliRenderer } from "@opentui/core";
import { createRoot, useRenderer } from "@opentui/react";
import { userInfo } from "node:os";
import { useCallback, useEffect, useState } from "react";
import { SessionList } from "./ui/SessionList.tsx";
import { hostLabel, isLinux, listSessions, type Session } from "./sessions.ts";
import { startWatch, demoMockStream } from "./watch.ts";
import { fetchHistory, renderPreamble } from "./history.ts";
import { formatGeo, lookup, lookupCached } from "./geoip.ts";
import { LocalTransport, SshTransport, type Transport } from "./transport.ts";

const MOCK = process.env.TWATCH_MOCK === "1" || process.argv.includes("--mock");

type Cli = {
  transport: Transport;
  remote: boolean;
};

function parseCli(): Cli {
  const argv = process.argv.slice(2);
  let remoteTarget: string | null = null;
  const sshExtra: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--remote" || a === "-r") {
      const v = argv[++i];
      if (!v) bail("--remote requires a user@host argument");
      remoteTarget = v;
    } else if (a === "-i") {
      const v = argv[++i];
      if (!v) bail("-i requires a path");
      sshExtra.push("-i", v);
    } else if (a === "-p") {
      const v = argv[++i];
      if (!v) bail("-p requires a port");
      sshExtra.push("-p", v);
    } else if (a === "-o") {
      const v = argv[++i];
      if (!v) bail("-o requires a value");
      sshExtra.push("-o", v);
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (a === "--mock") {
      // handled via MOCK; ignore here
    } else if (a.startsWith("-")) {
      bail(`unknown flag: ${a}`);
    } else {
      bail(`unexpected argument: ${a}`);
    }
  }
  if (remoteTarget) {
    return {
      transport: new SshTransport({ target: remoteTarget, extraArgs: sshExtra }),
      remote: true,
    };
  }
  return { transport: new LocalTransport(), remote: false };
}

function bail(msg: string): never {
  process.stderr.write(`twatch: ${msg}\n`);
  printHelp();
  process.exit(2);
}

function printHelp() {
  process.stderr.write(
    [
      "Usage: twatch [--remote user@host [-i KEY] [-p PORT] [-o OPT]] [--mock]",
      "",
      "  --remote, -r  USER@HOST   watch sessions on a remote box over SSH",
      "  -i PATH                   SSH identity file (forwarded to ssh -i)",
      "  -p PORT                   SSH port (forwarded to ssh -p)",
      "  -o OPT                    extra ssh -o option (repeatable)",
      "  --mock                    fake data for UI dev on non-Linux hosts",
      "",
      "Keys (in the list):     ↑/↓ move · Enter watch · r refresh · q quit",
      "Keys (while attached):  ← or Esc detach · Ctrl+C also detaches",
      "",
    ].join("\n"),
  );
}

const CLI = parseCli();

function App() {
  const renderer = useRenderer();
  const [sessions, setSessions] = useState<Session[]>(() => listSessions(CLI.transport));
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(() => {
    try {
      setSessions(listSessions(CLI.transport));
      setErr(null);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }, []);

  useEffect(() => {
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const quit = useCallback(() => {
    CLI.transport.close();
    renderer.destroy();
    process.exit(0);
  }, [renderer]);

  const onSelect = useCallback(
    async (target: Session) => {
      // Local Mac: refuse unless mocking.
      if (!MOCK && CLI.transport.isLocal() && !isLinux()) {
        setErr("Live watch only works on Linux. Run with TWATCH_MOCK=1 for a demo.");
        return;
      }
      if (!target.shellPid && !MOCK) {
        setErr(`No shell PID for ${target.tty}; can't attach.`);
        return;
      }

      const geoInfo = lookupCached(target.from) ?? (await lookup(target.from).catch(() => null));
      const history = MOCK
        ? { source: "(mock)", entries: ["ls -la", "vim deploy.yml", "sudo systemctl restart api"] }
        : fetchHistory(CLI.transport, target.user, 10, userInfo().username);
      const preamble = renderPreamble({
        user: target.user,
        tty: target.tty,
        from: target.from,
        geoLabel: formatGeo(geoInfo),
        loginAt: target.loginAt,
        idle: target.idle,
        foregroundComm: target.foregroundComm,
        history,
      });

      renderer.suspend();
      const handle = startWatch({
        transport: CLI.transport,
        shellPid: target.shellPid ?? 0,
        targetPts: target.ttyDev,
        useSudo: !MOCK,
        preamble,
        mockStream: MOCK ? demoMockStream() : undefined,
      });
      const result = await handle.done;
      renderer.resume();
      if (result.reason === "error") setErr(`watch failed: ${result.err}`);
      refresh();
    },
    [renderer, refresh],
  );

  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      <SessionList
        sessions={sessions}
        hostLabel={hostLabel(CLI.transport)}
        onSelect={onSelect}
        onQuit={quit}
        onRefresh={refresh}
      />
      {err ? (
        <box style={{ height: 1, backgroundColor: "#7f1d1d", paddingLeft: 1 }}>
          <text fg="#fecaca">{err}</text>
        </box>
      ) : null}
    </box>
  );
}

// If we're in remote mode, prime the SSH ControlMaster eagerly so the
// first listSessions() call doesn't take the connection-setup cost.
if (CLI.remote && CLI.transport instanceof SshTransport) {
  try {
    CLI.transport.open();
  } catch (e: any) {
    process.stderr.write(`twatch: ${String(e?.message ?? e)}\n`);
    process.exit(1);
  }
}

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  targetFps: 30,
});
createRoot(renderer).render(<App />);
