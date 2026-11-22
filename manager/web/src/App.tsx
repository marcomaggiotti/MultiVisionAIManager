import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { api } from "./api";
import { useLoad } from "./hooks";
import LiveStudio from "./pages/LiveStudio";
import Dashboard from "./pages/Dashboard";
import Sessions from "./pages/Sessions";
import Analyze from "./pages/Analyze";
import YoloStudio from "./pages/YoloStudio";
import ClipStudio from "./pages/ClipStudio";
import VlmStudio from "./pages/VlmStudio";
import { LiveSessionProvider, useLiveSession } from "./live/LiveSessionContext";

const NAV = [
  { to: "/", label: "Live studio" },
  { to: "/sessions", label: "Sessions" },
  { to: "/analysis", label: "Analysis" },
  { to: "/modules", label: "Modules" },
  { to: "/yolo", label: "YOLO" },
  { to: "/clip", label: "CLIP" },
  { to: "/vlm", label: "VLM" },
];
const STATUS_COLOR: Record<string, string> = { online: "var(--good)", starting: "var(--warn)", offline: "var(--muted)" };

export default function App() {
  return (
    <LiveSessionProvider>
      <Shell />
    </LiveSessionProvider>
  );
}

/** Shown next to "Live studio" while the session runs behind another tab. */
function LiveIndicator() {
  const { live } = useLiveSession();
  if (live.status !== "live") return null;
  return <span className="live-dot" title={live.capturePaused ? "Live session paused" : "Live session running"} style={{ marginLeft: 6, opacity: live.capturePaused ? 0.5 : 1 }} />;
}

function Shell() {
  const modules = useLoad(() => api<any[]>("/api/modules"), [], 8000);
  const wide = useLocation().pathname === "/";
  return (
    <div className="layout">
      <header className="topbar">
        <div className="brand"><span className="logo">✦</span>MultiVision <span className="muted" style={{ fontWeight: 400 }}>Ballet</span></div>
        <nav className="nav">
          {NAV.map((n) => <NavLink key={n.to} to={n.to} end={n.to === "/"}>{n.label}{n.to === "/" && <LiveIndicator />}</NavLink>)}
        </nav>
        <span className="spacer" />
        <select className="pill" style={{ width: "auto" }} defaultValue="ballet" title="Discipline">
          <option value="ballet">Classical ballet</option>
          <option disabled>More sports: coming</option>
        </select>
        <div className="row" style={{ gap: 6 }}>
          {(modules.data ?? []).map((m) => (
            <span key={m.name} className="pill" title={`${m.name}: ${m.status}`}>
              <span className="dot" style={{ background: STATUS_COLOR[m.status] ?? "var(--muted)", boxShadow: m.status === "online" ? "0 0 8px var(--good)" : undefined }} />
              {m.name.toUpperCase()}
            </span>
          ))}
        </div>
      </header>
      <main className={`content ${wide ? "wide" : ""}`}>
        <Routes>
          <Route path="/" element={<LiveStudio />} />
          <Route path="/sessions" element={<Sessions />} />
          <Route path="/analysis" element={<Analyze />} />
          <Route path="/modules" element={<Dashboard />} />
          <Route path="/yolo" element={<YoloStudio />} />
          <Route path="/clip" element={<ClipStudio />} />
          <Route path="/vlm" element={<VlmStudio />} />
        </Routes>
      </main>
    </div>
  );
}
