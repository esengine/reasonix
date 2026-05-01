// Reasonix dashboard SPA — Preact 10 + HTM, bundled by tsup. CDN imports stay external.

import htm from "htm";
import { h, render } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
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

const TAB_SECTIONS = [
  {
    label: "workspace",
    tabs: [
      { id: "chat", name: "Chat", glyph: "◆", panel: () => html`<${ChatPanel} />` },
      { id: "plans", name: "Plans", glyph: "⊞", panel: () => html`<${PlansPanel} />` },
      { id: "sessions", name: "Sessions", glyph: "›", panel: () => html`<${SessionsPanel} />` },
    ],
  },
  {
    label: "observe",
    tabs: [
      { id: "overview", name: "Overview", glyph: "◈", panel: () => html`<${OverviewPanel} />` },
      { id: "usage", name: "Usage", glyph: "$", panel: () => html`<${UsagePanel} />` },
      { id: "health", name: "System", glyph: "+", panel: () => html`<${SystemPanel} />` },
      { id: "semantic", name: "Semantic", glyph: "≈", panel: () => html`<${SemanticPanel} />` },
    ],
  },
  {
    label: "configure",
    tabs: [
      { id: "tools", name: "Tools", glyph: "▣", panel: () => html`<${ToolsPanel} />` },
      { id: "permissions", name: "Permissions", glyph: "▎", panel: () => html`<${PermissionsPanel} />` },
      { id: "mcp", name: "MCP", glyph: "M", panel: () => html`<${McpPanel} />` },
      { id: "skills", name: "Skills", glyph: "S", panel: () => html`<${SkillsPanel} />` },
      { id: "memory", name: "Memory", glyph: "·", panel: () => html`<${MemoryPanel} />` },
      { id: "hooks", name: "Hooks", glyph: "H", panel: () => html`<${HooksPanel} />` },
      { id: "settings", name: "Settings", glyph: "⌘", panel: () => html`<${SettingsPanel} />` },
    ],
  },
];

const ALL_TABS = TAB_SECTIONS.flatMap((s) => s.tabs);

function App() {
  const [activeId, setActiveId] = useState("chat");
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
  const active = ALL_TABS.find((t) => t.id === activeId) ?? ALL_TABS[0];

  useEffect(() => {
    const onNav = (ev) => {
      const id = ev.detail?.tabId;
      if (id) setActiveId(id);
    };
    appBus.addEventListener("navigate-tab", onNav);
    return () => appBus.removeEventListener("navigate-tab", onNav);
  }, []);

  const pickTab = useCallback((id) => setActiveId(id), []);

  return html`
    <div class=${`app ${sidebarCollapsed ? "collapsed" : ""}`}>
      <aside class="app-side">
        <div class="brand">
          <span class="glyph">◈</span>
          <span class="label">REASONIX</span>
          <span class="ver">${MODE}</span>
        </div>
        <div class="side-tabs">
          ${TAB_SECTIONS.map(
            (section) => html`
              <div class="side-section">${section.label}</div>
              ${section.tabs.map(
                (tab) => html`
                  <div
                    class=${`side-tab ${tab.id === active.id ? "active" : ""}`}
                    onClick=${() => pickTab(tab.id)}
                    title=${tab.name}
                  >
                    <span class="g">${tab.glyph}</span>
                    <span class="label">${tab.name}</span>
                  </div>
                `,
              )}
            `,
          )}
        </div>
        <div class="side-foot">
          <span class="label">127.0.0.1</span>
          <span
            class="toggle"
            title=${sidebarCollapsed ? "expand" : "collapse"}
            onClick=${() => setSidebarCollapsed((c) => !c)}
          >${sidebarCollapsed ? "»" : "«"}</span>
        </div>
      </aside>
      <header class="app-top">
        <span class="ws">
          <span class="path">dashboard</span>
          <span class="sep">·</span>
          <span class="branch">${MODE}</span>
        </span>
        <span class="grow"></span>
      </header>
      <div class="app-body">
        <${ErrorBoundary}>${active.panel()}<//>
      </div>
      <footer class="app-status">
        <span class="grow"></span>
        <span class="item">127.0.0.1 only · token-gated</span>
      </footer>
    </div>
    <${ToastStack} />
    <${ErrorOverlay} />
  `;
}

render(html`<${App} />`, document.getElementById("root"));
