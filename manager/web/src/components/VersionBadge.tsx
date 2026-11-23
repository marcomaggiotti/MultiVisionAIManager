import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { CHANGELOG } from "../changelog";

const CHECK_EVERY_MS = 60_000;
export const WEB_VERSION = __APP_VERSION__;

/** "0.10.0" vs "0.9.0" → 1 (part by part, as numbers). */
export function compareVersions(first: string, second: string): number {
  const a = first.split(".").map(Number), b = second.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

const builtAt = new Date(__BUILD_TIME__);
const buildLabel = `${builtAt.toLocaleDateString()} ${builtAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

/** The version in the top bar: this page's, compared with the running manager's. Click: what's new. */
export function VersionBadge() {
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const check = () => api<{ version: string }>("/api/version").then((info) => setServerVersion(info.version)).catch(() => setServerVersion(null));
    check();
    const timer = window.setInterval(check, CHECK_EVERY_MS);
    return () => window.clearInterval(timer);
  }, []);

  const mismatch = serverVersion !== null && serverVersion !== WEB_VERSION;
  const newer = mismatch && compareVersions(serverVersion!, WEB_VERSION) > 0; // the server was updated after this page loaded
  const title = mismatch
    ? newer
      ? `The server runs ${serverVersion}: reload the page to get it.`
      : `The server runs ${serverVersion}, this page is ${WEB_VERSION}: rebuild both (docker compose up -d --build).`
    : `Page and server ${WEB_VERSION} · built ${buildLabel}${__GIT_COMMIT__ ? ` · commit ${__GIT_COMMIT__}` : ""}`;

  return (
    <>
      <button className={`version-badge ${mismatch ? "warn" : ""}`} onClick={() => setOpen(true)} title={title}>
        v{WEB_VERSION}{mismatch && <span> ⚠ server v{serverVersion}</span>}
      </button>
      {mismatch && newer && <button className="small" onClick={() => location.reload()} title={title}>↻ Reload</button>}
      {open && createPortal(
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="glass modal whats-new" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="What's new">
            <div className="row spread">
              <h3 style={{ margin: 0 }}>What's new</h3>
              <button className="small ghost" onClick={() => setOpen(false)} aria-label="Close">✕</button>
            </div>
            <p className="small muted">
              This page: <b>v{WEB_VERSION}</b>, built {buildLabel}{__GIT_COMMIT__ ? ` (commit ${__GIT_COMMIT__})` : ""} · server: <b>{serverVersion ? `v${serverVersion}` : "not reachable"}</b>
            </p>
            {mismatch && <div className="notice" style={{ color: "var(--warn)" }}>{title}</div>}
            {CHANGELOG.map((release) => (
              <section key={release.version} className={`release ${release.version === WEB_VERSION ? "current" : ""}`}>
                <div className="row spread"><b>v{release.version} · {release.title}</b><span className="small muted">{release.date}</span></div>
                <ul>{release.changes.map((change) => <li key={change} className="small">{change}</li>)}</ul>
              </section>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
