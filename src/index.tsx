import { createCliRenderer } from "@opentui/core";
import { createRoot, useRenderer } from "@opentui/react";
import { userInfo } from "node:os";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SessionList } from "./ui/SessionList.tsx";
import { TargetsList } from "./ui/TargetsList.tsx";
import { AddTargetForm } from "./ui/AddTargetForm.tsx";
import { hostLabel, isLinux, listSessionsAsync, type Session } from "./sessions.ts";
import { startWatch, demoMockStream } from "./watch.ts";
import { fetchHistory, renderPreamble } from "./history.ts";
import { formatGeo, lookup, lookupCached } from "./geoip.ts";
import { LocalTransport, SshTransport, type Transport } from "./transport.ts";
import { listTargets, LOCAL_TARGET, targetToSsh, type Target } from "./targets.ts";
import { checkForUpdate, getInstalledVersion, runSelfUpdate, type UpdateState } from "./updater.ts";

const MOCK = process.env.TWATCH_MOCK === "1" || process.argv.includes("--mock");

type Cli = {
  // If set, skip the targets picker and go straight to this transport.
  preselectedTransport: Transport | null;
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
      // A destination starting with "-" would be parsed by ssh as an
      // option (e.g. "-oProxyCommand=…"), not a host — refuse it.
      if (v.startsWith("-")) bail(`--remote value looks like an ssh flag, refusing: ${v}`);
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
    } else if (a === "--version" || a === "-v") {
      process.stdout.write(`twatch ${getInstalledVersion()}\n`);
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
      preselectedTransport: new SshTransport({ target: remoteTarget, extraArgs: sshExtra }),
    };
  }
  return { preselectedTransport: null };
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
      "Without --remote, twatch opens a targets picker (local + ssh-config",
      "Host entries + saved targets) — Enter to open one.",
      "",
      "  --remote, -r  USER@HOST   skip the picker, open this remote directly",
      "  -i PATH                   SSH identity file (forwarded to ssh -i)",
      "  -p PORT                   SSH port (forwarded to ssh -p)",
      "  -o OPT                    extra ssh -o option (repeatable)",
      "  --mock                    fake data for UI dev on non-Linux hosts",
      "  --version, -v             print version and exit",
      "  --help, -h                this message",
      "",
      "Keys (targets):    ↑/↓ move · Enter open · r refresh · q quit",
      "Keys (sessions):   ↑/↓ move · Enter watch · r refresh · Esc back · q quit",
      "Keys (attached):   ← or Esc detach · Ctrl+C also detaches",
      "",
    ].join("\n"),
  );
}

const CLI = parseCli();

type Screen =
  | { kind: "targets" }
  | { kind: "add-target" }
  | { kind: "sessions"; transport: Transport; target: Target | null };

function App() {
  const renderer = useRenderer();

  const [targets, setTargets] = useState<Target[]>(() => listTargets());
  const [screen, setScreen] = useState<Screen>(() => {
    if (CLI.preselectedTransport) {
      return { kind: "sessions", transport: CLI.preselectedTransport, target: null };
    }
    return { kind: "targets" };
  });
  const [banner, setBanner] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateState>(() => checkForUpdate((later) => setUpdate(later)));

  const runUpdate = useCallback(() => {
    renderer.suspend();
    process.stdout.write(`\x1b[2J\x1b[H\x1b[36mUpdating terminalwatch to ${update.latest ?? "latest"} …\x1b[0m\r\n\r\n`);
    const r = runSelfUpdate();
    process.stdout.write(r.stdout);
    process.stdout.write(r.stderr);
    if (r.status === 0) {
      process.stdout.write(`\r\n\x1b[32m✓\x1b[0m updated. Re-run \`twatch\` to use the new version.\r\n`);
    } else {
      process.stdout.write(`\r\n\x1b[31m✗\x1b[0m update failed (exit ${r.status}).\r\n`);
    }
    process.exit(r.status ?? 0);
  }, [renderer, update]);

  const refreshTargets = useCallback(() => {
    setTargets(listTargets());
    setBanner(null);
  }, []);

  const quit = useCallback(() => {
    if (screen.kind === "sessions") {
      try { screen.transport.close(); } catch {}
    }
    renderer.destroy();
    process.exit(0);
  }, [renderer, screen]);

  const openTarget = useCallback((t: Target) => {
    if (t.kind === "local") {
      setScreen({ kind: "sessions", transport: new LocalTransport(), target: t });
      return;
    }
    const ssh = targetToSsh(t);
    if (!ssh) return;
    let transport: SshTransport;
    try {
      transport = new SshTransport({ target: ssh.target, extraArgs: ssh.extraArgs });
      transport.open();
    } catch (e: any) {
      setBanner(`ssh ${ssh.target} failed: ${String(e?.message ?? e).split("\n")[0]}`);
      return;
    }
    setScreen({ kind: "sessions", transport, target: t });
  }, []);

  const backToTargets = useCallback(() => {
    if (screen.kind === "sessions") {
      try { screen.transport.close(); } catch {}
    }
    setScreen({ kind: "targets" });
  }, [screen]);

  if (screen.kind === "targets") {
    return (
      <TargetsList
        targets={targets}
        onSelect={openTarget}
        onAdd={() => setScreen({ kind: "add-target" })}
        onQuit={quit}
        onRefresh={refreshTargets}
        banner={banner}
        update={update}
        onUpdate={runUpdate}
      />
    );
  }

  if (screen.kind === "add-target") {
    return (
      <AddTargetForm
        onSaved={() => { refreshTargets(); setScreen({ kind: "targets" }); }}
        onCancel={() => setScreen({ kind: "targets" })}
      />
    );
  }

  return (
    <SessionsScreen
      transport={screen.transport}
      target={screen.target}
      onQuit={quit}
      onBack={backToTargets}
      canGoBack={!CLI.preselectedTransport}
      update={update}
      onUpdate={runUpdate}
    />
  );
}

function SessionsScreen(props: {
  transport: Transport;
  target: Target | null;
  onQuit: () => void;
  onBack: () => void;
  canGoBack: boolean;
  update: UpdateState;
  onUpdate: () => void;
}) {
  const renderer = useRenderer();
  const { transport, target, onQuit, onBack, canGoBack, update, onUpdate } = props;
  const [sessions, setSessions] = useState<Session[]>([]);
  const [err, setErr] = useState<string | null>(null);
  // Guards for the async refresh: skip a tick if the previous one is still
  // in flight (SSH round-trips can outlast the 3s interval), and never call
  // setState after this screen has unmounted.
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const refresh = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    listSessionsAsync(transport)
      .then((s) => { if (mounted.current) { setSessions(s); setErr(null); } })
      .catch((e: any) => { if (mounted.current) setErr(String(e?.message ?? e)); })
      .finally(() => { inFlight.current = false; });
  }, [transport]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const title = useMemo(() => {
    if (target?.kind === "ssh") return target.label;
    return hostLabel(transport);
  }, [target, transport]);

  const onSelect = useCallback(
    async (sess: Session) => {
      if (!MOCK && transport.isLocal() && !isLinux()) {
        setErr("Live watch only works on Linux. Run with TWATCH_MOCK=1 for a demo.");
        return;
      }
      if (!sess.shellPid && !MOCK) {
        setErr(`No shell PID for ${sess.tty}; can't attach.`);
        return;
      }

      const geoInfo = lookupCached(sess.from) ?? (await lookup(sess.from).catch(() => null));
      const history = MOCK
        ? { source: "(mock)", entries: ["ls -la", "vim deploy.yml", "sudo systemctl restart api"] }
        : fetchHistory(transport, sess.user, 10, userInfo().username);
      const preamble = renderPreamble({
        user: sess.user,
        tty: sess.tty,
        from: sess.from,
        geoLabel: formatGeo(geoInfo),
        loginAt: sess.loginAt,
        idle: sess.idle,
        foregroundComm: sess.foregroundComm,
        history,
      });

      renderer.suspend();
      const handle = startWatch({
        transport,
        shellPid: sess.shellPid ?? 0,
        targetPts: sess.ttyDev,
        useSudo: !MOCK,
        preamble,
        mockStream: MOCK ? demoMockStream() : undefined,
      });
      const result = await handle.done;
      renderer.resume();
      if (result.reason === "error") setErr(`watch failed: ${result.err}`);
      refresh();
    },
    [renderer, refresh, transport],
  );

  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      <SessionList
        sessions={sessions}
        hostLabel={title}
        onSelect={onSelect}
        onQuit={onQuit}
        onRefresh={refresh}
        onBack={canGoBack ? onBack : undefined}
        update={update}
        onUpdate={onUpdate}
      />
      {err ? (
        <box style={{ height: 1, backgroundColor: "#7f1d1d", paddingLeft: 1 }}>
          <text fg="#fecaca">{err}</text>
        </box>
      ) : null}
    </box>
  );
}

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  targetFps: 30,
});
createRoot(renderer).render(<App />);
