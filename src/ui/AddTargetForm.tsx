import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import { saveTarget, STORE_PATH } from "../targets.ts";

type Props = {
  onSaved: () => void;
  onCancel: () => void;
};

const FIELDS = ["name", "user", "host", "port", "identityFile"] as const;
type Field = typeof FIELDS[number];

const LABELS: Record<Field, string> = {
  name:         "Name        ",
  user:         "User        ",
  host:         "Host        ",
  port:         "Port        ",
  identityFile: "Identity    ",
};

const PLACEHOLDERS: Record<Field, string> = {
  name:         "e.g. staging  (optional, default = user@host)",
  user:         "e.g. azureuser",
  host:         "e.g. vps.example.com  or  10.0.0.7",
  port:         "e.g. 22  (optional, default = 22)",
  identityFile: "e.g. ~/.ssh/key.pem  (optional)",
};

export function AddTargetForm({ onSaved, onCancel }: Props) {
  const [values, setValues] = useState<Record<Field, string>>({
    name: "", user: "", host: "", port: "", identityFile: "",
  });
  const [focused, setFocused] = useState<Field>("name");
  const [err, setErr] = useState<string | null>(null);

  useKeyboard((k) => {
    if (k.name === "escape") return onCancel();
    if (k.name === "tab") {
      const i = FIELDS.indexOf(focused);
      const next = FIELDS[(i + 1) % FIELDS.length]!;
      setFocused(next);
      return;
    }
    if (k.ctrl && k.name === "s") return submit();
  });

  function setField(f: Field, v: string) {
    setValues((m) => ({ ...m, [f]: v }));
  }

  function submit() {
    const user = values.user.trim();
    const host = values.host.trim();
    if (!user || !host) {
      setErr("User and Host are required.");
      return;
    }
    const portRaw = values.port.trim();
    let port: number | undefined;
    if (portRaw) {
      const n = parseInt(portRaw, 10);
      if (!Number.isFinite(n) || n <= 0 || n > 65535) {
        setErr("Port must be a number between 1 and 65535.");
        return;
      }
      port = n;
    }
    const identity = values.identityFile.trim() || undefined;
    const name = values.name.trim() || `${user}@${host}`;
    try {
      saveTarget({ name, user, host, port, identityFile: identity });
      onSaved();
    } catch (e: any) {
      setErr(`save failed: ${String(e?.message ?? e)}`);
    }
  }

  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      <box style={{ height: 1, backgroundColor: "#1e3a5f", paddingLeft: 1, paddingRight: 1 }}>
        <text fg="#7dd3fc">
          <strong>twatch</strong>
          <span fg="#888"> — add server (saved to {STORE_PATH})</span>
        </text>
      </box>

      <box style={{ flexGrow: 1, flexDirection: "column", padding: 2, gap: 1 }}>
        {FIELDS.map((f) => (
          <box key={f} style={{ flexDirection: "row", height: 3 }}>
            <box style={{ width: 14, height: 1, paddingTop: 1 }}>
              <text fg={focused === f ? "#7dd3fc" : "#94a3b8"}>{LABELS[f]}</text>
            </box>
            <box style={{ border: true, height: 3, flexGrow: 1 }}>
              <input
                value={values[f]}
                placeholder={PLACEHOLDERS[f]}
                onInput={(v) => setField(f, v)}
                onSubmit={submit}
                focused={focused === f}
              />
            </box>
          </box>
        ))}
        {err ? (
          <box style={{ height: 1, paddingLeft: 1 }}>
            <text fg="#fca5a5">{err}</text>
          </box>
        ) : null}
      </box>

      <box style={{ height: 1, backgroundColor: "#0b1220", paddingLeft: 1 }}>
        <text fg="#64748b">
          Tab next field · Enter or Ctrl+S save · Esc cancel
        </text>
      </box>
    </box>
  );
}
