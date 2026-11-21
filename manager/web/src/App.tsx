import { NavLink, Route, Routes } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import Analyze from "./pages/Analyze";
import YoloStudio from "./pages/YoloStudio";
import ClipStudio from "./pages/ClipStudio";
import VlmStudio from "./pages/VlmStudio";

const NAV = [
  { to: "/", label: "Dashboard", color: "var(--manager)" },
  { to: "/analyze", label: "Ballet analysis", color: "var(--manager)" },
  { to: "/yolo", label: "YOLO", color: "var(--yolo)" },
  { to: "/clip", label: "CLIP", color: "var(--clip)" },
  { to: "/vlm", label: "VLM", color: "var(--vlm)" },
];

export default function App() {
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          MultiVision AI Manager
          <span>movement in sport · classical ballet</span>
        </div>
        <nav className="nav">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === "/"}>
              <span className="dot" style={{ background: n.color }} />
              {n.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="content">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/analyze" element={<Analyze />} />
          <Route path="/yolo" element={<YoloStudio />} />
          <Route path="/clip" element={<ClipStudio />} />
          <Route path="/vlm" element={<VlmStudio />} />
        </Routes>
      </main>
    </div>
  );
}
