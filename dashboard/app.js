// Reasonix dashboard SPA — Preact 10 + HTM, bundled by tsup. CDN imports stay external.

import htm from "htm";
import { h, render } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { MODE } from "./src/lib/api";
import { ToastStack, appBus } from "./src/lib/bus";
import { ErrorBoundary, ErrorOverlay } from "./src/lib/error-boundary";
import { t, useLang } from "./src/i18n";
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

function tabSections() {
  return [
    {
      label: t("app.sectionWorkspace"),
      tabs: [
        { id: "chat", name: t("app.tabChat"), glyph: "◆", panel: () => html`<${ChatPanel} />` },
        { id: "plans", name: t("app.tabPlans"), glyph: "⊞", panel: () => html`<${PlansPanel} />` },
        { id: "sessions", name: t("app.tabSessions"), glyph: "›", panel: () => html`<${SessionsPanel} />` },
      ],
    },
    {
      label: t("app.sectionObserve"),
      tabs: [
        { id: "overview", name: t("app.tabOverview"), glyph: "◈", panel: () => html`<${OverviewPanel} />` },
        { id: "usage", name: t("app.tabUsage"), glyph: "$", panel: () => html`<${UsagePanel} />` },
        { id: "health", name: t("app.tabSystem"), glyph: "+", panel: () => html`<${SystemPanel} />` },
        { id: "semantic", name: t("app.tabSemantic"), glyph: "≈", panel: () => html`<${SemanticPanel} />` },
      ],
    },
    {
      label: t("app.sectionConfigure"),
      tabs: [
        { id: "tools", name: t("app.tabTools"), glyph: "▣", panel: () => html`<${ToolsPanel} />` },
        { id: "permissions", name: t("app.tabPermissions"), glyph: "▎", panel: () => html`<${PermissionsPanel} />` },
        { id: "mcp", name: t("app.tabMcp"), glyph: "M", panel: () => html`<${McpPanel} />` },
        { id: "skills", name: t("app.tabSkills"), glyph: "S", panel: () => html`<${SkillsPanel} />` },
        { id: "memory", name: t("app.tabMemory"), glyph: "·", panel: () => html`<${MemoryPanel} />` },
        { id: "hooks", name: t("app.tabHooks"), glyph: "H", panel: () => html`<${HooksPanel} />` },
        { id: "settings", name: t("app.tabSettings"), glyph: "⌘", panel: () => html`<${SettingsPanel} />` },
      ],
    },
  ];
}

function App() {
  useLang();
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
  const TAB_SECTIONS = tabSections();
  const ALL_TABS = TAB_SECTIONS.flatMap((s) => s.tabs);
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
        <span class="item">${t("app.footer")}</span>
      </footer>
    </div>
    <${ToastStack} />
    <${ErrorOverlay} />
  `;
}

render(html`<${App} />`, document.getElementById("root"));
