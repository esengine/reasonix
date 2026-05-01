// Reasonix dashboard SPA — Preact 10 + HTM, bundled by tsup. CDN imports stay external.

import htm from "https://esm.sh/htm@3.1.1";
import { h, render } from "https://esm.sh/preact@10.22.0";
import { useCallback, useEffect, useState } from "https://esm.sh/preact@10.22.0/hooks";
import { MODE } from "./src/lib/api";
import { ToastStack, appBus } from "./src/lib/bus";
import { ErrorBoundary, ErrorOverlay } from "./src/lib/error-boundary";
import { ChatPanel } from "./src/panels/chat";
import { HooksPanel } from "./src/panels/hooks";
import { McpPanel } from "./src/panels/mcp";
import { MemoryPanel } from "./src/panels/memory";
import { OverviewPanel } from "./src/panels/overview";
import { PermissionsPanel } from "./src/panels/permissions";
import { PlansPanel } from "./src/panels/plans";
import { SemanticPanel } from "./src/panels/semantic";
import { SessionsPanel } from "./src/panels/sessions";
import { SettingsPanel } from "./src/panels/settings";
import { SkillsPanel } from "./src/panels/skills";
import { SystemPanel } from "./src/panels/system";
import { ToolsPanel } from "./src/panels/tools";
import { UsagePanel } from "./src/panels/usage";

const html = htm.bind(h);

const TABS = [
  { id: "chat", name: "Chat", glyph: "◆", panel: () => html`<${ChatPanel} />`, ready: true, badge: null },
  { id: "overview", name: "Overview", glyph: "◈", panel: () => html`<${OverviewPanel} />`, ready: true, badge: null },
  { id: "usage", name: "Usage", glyph: "$", panel: () => html`<${UsagePanel} />`, ready: true, badge: null },
  { id: "sessions", name: "Sessions", glyph: "›", panel: () => html`<${SessionsPanel} />`, ready: true, badge: null },
  { id: "plans", name: "Plans", glyph: "P", panel: () => html`<${PlansPanel} />`, ready: true, badge: null },
  { id: "tools", name: "Tools", glyph: "▣", panel: () => html`<${ToolsPanel} />`, ready: true, badge: null },
  { id: "permissions", name: "Permissions", glyph: "▎", panel: () => html`<${PermissionsPanel} />`, ready: true, badge: null },
  { id: "health", name: "System", glyph: "+", panel: () => html`<${SystemPanel} />`, ready: true, badge: null },
  { id: "semantic", name: "Semantic", glyph: "≈", panel: () => html`<${SemanticPanel} />`, ready: true, badge: null },
  { id: "mcp", name: "MCP", glyph: "M", panel: () => html`<${McpPanel} />`, ready: true, badge: null },
  { id: "skills", name: "Skills", glyph: "S", panel: () => html`<${SkillsPanel} />`, ready: true, badge: null },
  { id: "memory", name: "Memory", glyph: "·", panel: () => html`<${MemoryPanel} />`, ready: true, badge: null },
  { id: "hooks", name: "Hooks", glyph: "H", panel: () => html`<${HooksPanel} />`, ready: true, badge: null },
  { id: "settings", name: "Settings", glyph: "⌘", panel: () => html`<${SettingsPanel} />`, ready: true, badge: null },
];

function App() {
  const [activeId, setActiveId] = useState("chat");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Desktop "icon only" collapse — persisted so the choice survives reload.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem("rx.sidebarCollapsed") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("rx.sidebarCollapsed", sidebarCollapsed ? "1" : "0");
    } catch {
      /* private mode / disabled storage — ignore */
    }
  }, [sidebarCollapsed]);
  const active = TABS.find((t) => t.id === activeId) ?? TABS[0];

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") setSidebarOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const onNav = (ev) => {
      const id = ev.detail?.tabId;
      if (id) setActiveId(id);
    };
    appBus.addEventListener("navigate-tab", onNav);
    return () => appBus.removeEventListener("navigate-tab", onNav);
  }, []);

  const pickTab = useCallback((id) => {
    setActiveId(id);
    setSidebarOpen(false);
  }, []);

  return html`
    <div class=${`sidebar ${sidebarOpen ? "open" : ""} ${sidebarCollapsed ? "collapsed" : ""}`}>
      <div class="sidebar-header">
        <div class="sidebar-brand" title="Reasonix"><span class="glyph">◈</span><span class="sidebar-label"> REASONIX</span></div>
        <div class="sidebar-version sidebar-label">dashboard</div>
        <div class="sidebar-mode sidebar-label">${MODE}</div>
      </div>
      <div class="gradient-rule"></div>
      <div class="sidebar-tabs">
        ${TABS.map(
          (tab) => html`
          <div
            class="tab ${tab.id === active.id ? "active" : ""} ${!tab.ready ? "tab-stub" : ""}"
            onClick=${() => tab.ready && pickTab(tab.id)}
            title=${tab.name}
          >
            <span class="glyph">${tab.glyph}</span>
            <span class="sidebar-label">${tab.name}</span>
            ${tab.badge ? html`<span class="badge sidebar-label">${tab.badge}</span>` : null}
          </div>
        `,
        )}
      </div>
      <button
        class="sidebar-collapse-toggle"
        onClick=${() => setSidebarCollapsed((c) => !c)}
        title=${sidebarCollapsed ? "expand sidebar" : "collapse to icons"}
      >${sidebarCollapsed ? "▶" : "◀"}<span class="sidebar-label">  ${sidebarCollapsed ? "expand" : "collapse"}</span></button>
      <div class="sidebar-footer sidebar-label">127.0.0.1 only · token-gated</div>
    </div>
    <div class="sidebar-backdrop" onClick=${() => setSidebarOpen(false)}></div>
    <button class="menu-toggle" onClick=${() => setSidebarOpen((s) => !s)} aria-label="Toggle sidebar">≡</button>
    <div class="main">
      <${ErrorBoundary}>${active.panel()}<//>
    </div>
    <${ToastStack} />
    <${ErrorOverlay} />
  `;
}

render(html`<${App} />`, document.getElementById("root"));
