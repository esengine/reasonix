// Reasonix landing — i18n auto-switch (en / zh).
// Detection precedence: ?lang=xx → localStorage → navigator.language → "en".
// Falls back gracefully when localStorage is unavailable (private mode, etc).

(function () {
  "use strict";

  const STORAGE_KEY = "reasonix.lang";
  const DEFAULT_LANG = "en";
  const SUPPORTED = ["en", "zh"];

  const translations = {
    en: {
      "nav.features": "Features",
      "nav.quickstart": "Quick start",
      "nav.benchmarks": "Benchmarks",
      "nav.github": "GitHub",

      "hero.badge": "v{version} · DeepSeek V4 · cache-first",
      "hero.title.line1": "DeepSeek-native",
      "hero.title.line2": "AI coding agent in your terminal",
      "hero.sub":
        "Cache-first agent loop for DeepSeek V4 (flash + pro). Edits files as reviewable SEARCH/REPLACE blocks. Ink TUI. MCP first-class. No LangChain.",
      "hero.copy": "Copy",
      "hero.copy.done": "Copied",
      "hero.cta.start": "Get started →",
      "hero.cta.star": "Star on GitHub",
      "hero.stat.cache": "prefix cache hit rate",
      "hero.stat.cost": "cheaper vs Claude Sonnet 4.6",
      "hero.stat.pass": "τ-bench-lite pass rate",

      "term.user":
        "users.ts findByEmail is case-sensitive — login fails for users with uppercase emails",
      "term.found":
        "▸ Found it. findByEmail uses === directly. Switch to lowercase normalization.",
      "term.pending": "▸ 1 pending edit · /apply to write · /discard to drop",

      "why.title": "Why Reasonix",
      "why.sub":
        "Every abstraction earns its weight against a DeepSeek-specific property — dirt-cheap tokens, R1 traces, automatic prefix caching, JSON mode. Generic wrappers leave these on the table.",
      "why.cache.title": "Cache-first loop",
      "why.cache.body":
        "Append-only conversation log keeps the prompt prefix byte-stable across turns, so DeepSeek's automatic cache hits 85–95% — not 40%.",
      "why.cost.title": "Cost is a pillar",
      "why.cost.body":
        "Flash-first defaults, turn-end auto-compaction, model self-escalation when (and only when) needed. Per-turn cost badge in the TUI.",
      "why.tui.title": "Ink TUI, no web",
      "why.tui.body":
        "Lives in your terminal. Streaming preview, slash commands, plan picker, edit-confirm modal. Plain mode for stubborn Windows shells.",
      "why.mcp.title": "MCP first-class",
      "why.mcp.body":
        "Stdio + HTTP+SSE transports. Live progress notifications. Same cache-safety + repair plumbing as native tools.",
      "why.safe.title": "Reviewable edits",
      "why.safe.body":
        "Edits arrive as SEARCH/REPLACE blocks; nothing hits disk until /apply. Per-file diff confirm modal, undo history, sandboxed paths.",
      "why.ctx.title": "1M-token aware",
      "why.ctx.body":
        "Context gauge with proactive compaction, oversized tool-result repair, forced-summary fallback near the window edge.",

      "qs.title": "Quick start (60 seconds)",
      "qs.step1.title": "Get a DeepSeek API key",
      "qs.step1.body":
        'Free credit on signup at <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener">platform.deepseek.com</a>.',
      "qs.step2.title": "Point it at a project",
      "qs.step2.body": "No install needed.",
      "qs.step2.note":
        "First run walks you through a 30-second wizard (paste API key → pick preset → pick MCP servers).",
      "qs.step3.title": "Ask it to edit",
      "qs.step3.body":
        "The model proposes edits as SEARCH/REPLACE blocks — nothing hits disk until you <code>/apply</code>.",
      "qs.req":
        "Requires Node ≥ 22. macOS, Linux, Windows (PowerShell · Git Bash · Windows Terminal). Press <kbd>Esc</kbd> anytime to abort; <code>/help</code> for the full command list.",

      "feat.title": "In the box",
      "feat.code.title": "Pair programmer mode",
      "feat.code.body":
        "<code>read_file</code> · <code>write_file</code> · <code>edit_file</code> · <code>search_files</code> · <code>directory_tree</code> · <code>run_command</code> with read-only allowlist. Sandboxed to the launch root — no path escapes. Plan mode and per-edit review modal.",
      "feat.memory.title": "Two-layer memory",
      "feat.memory.body":
        "Committable <code>REASONIX.md</code> for team conventions plus a private per-user <code>~/.reasonix/memory/</code> with global and per-project scopes. The model can write to it via the <code>remember</code> tool.",
      "feat.skills.title": "User-authored prompt packs",
      "feat.skills.body":
        "Drop <code>SKILL.md</code> files anywhere. Names + descriptions are pinned in the prefix; the model picks them autonomously, or you trigger with <code>/skill name</code>.",
      "feat.hooks.title": "Lifecycle hooks",
      "feat.hooks.body":
        "Shell commands fire at <code>PreToolUse</code> · <code>PostToolUse</code> · <code>UserPromptSubmit</code> · <code>Stop</code>. Exit code drives pass / block / warn.",
      "feat.mcp.title": "Bring your own tools",
      "feat.mcp.body":
        'Wizard catalog, or <code>--mcp "name=cmd"</code> to attach stdio / HTTP+SSE servers on the fly. Live progress bars on long calls.',
      "feat.web.title": "Web search built-in",
      "feat.web.body":
        "<code>web_search</code> + <code>web_fetch</code> via Mojeek — no key, no signup, off-by-flag for offline / CI. Bring-your-own provider via the <code>WebSearchProvider</code> interface.",

      "bench.title": "Verify the cache claim yourself",
      "bench.sub":
        "On the same τ-bench-lite workload (8 multi-turn tool-use tasks × 3 repeats = 48 runs per side), live DeepSeek <code>deepseek-chat</code>, sole variable prefix stability:",
      "bench.col.metric": "metric",
      "bench.col.baseline": "baseline (cache-hostile)",
      "bench.col.reasonix": "Reasonix",
      "bench.col.delta": "delta",
      "bench.row.cache": "cache hit",
      "bench.row.cost": "cost / task",
      "bench.row.pass": "pass rate",
      "bench.repro.intro": "Reproduce without spending an API credit:",
      "bench.repro.note":
        "The committed JSONL transcripts carry per-turn <code>usage</code>, <code>cost</code>, and <code>prefixHash</code>. Reasonix's prefix hash stays byte-stable across every model call.",

      "cli.title": "CLI at a glance",
      "cli.code": "coding mode scoped to path",
      "cli.chat": "chat (uses saved config)",
      "cli.setup": "reconfigure the wizard",
      "cli.run": "one-shot, streams to stdout",
      "cli.stats": "cross-session cost dashboard",
      "cli.mcp": "probe a single MCP server",
      "cli.flags.intro": "Common flags:",
      "cli.f.preset": "model + harvest + branch bundle",
      "cli.f.model": "explicit DeepSeek model id",
      "cli.f.mcp": "attach an MCP server (repeatable)",
      "cli.f.session": "named session",
      "cli.f.noconf": "ignore ~/.reasonix/config.json (CI)",

      "ctab.title": "Ready to try?",
      "ctab.sub": "One <code>npx</code> away. Sandboxed. Reviewable. 98% cheaper.",
      "ctab.gh": "GitHub repository →",
      "ctab.npm": "npm package",

      "foot.tag": "DeepSeek does deep, deeply.",
      "foot.col.project": "Project",
      "foot.col.docs": "Docs",
      "foot.col.community": "Community",
      "foot.changelog": "Changelog",
      "foot.readme": "README",
      "foot.readme.zh": "中文 README",
      "foot.arch": "Architecture",
      "foot.issues": "Issues",
      "foot.discuss": "Discussions",
      "foot.copyright": "© 2026 Reasonix · MIT License",
    },

    zh: {
      "nav.features": "特性",
      "nav.quickstart": "快速上手",
      "nav.benchmarks": "性能对比",
      "nav.github": "GitHub",

      "hero.badge": "v{version} · DeepSeek V4 · 缓存优先",
      "hero.title.line1": "DeepSeek 原生",
      "hero.title.line2": "终端里的 AI 编程代理",
      "hero.sub":
        "为 DeepSeek V4（flash + pro）打造的缓存优先 agent 循环。编辑以可审查的 SEARCH/REPLACE 块呈现，落盘前必须确认。Ink TUI、原生支持 MCP，不依赖 LangChain。",
      "hero.copy": "复制",
      "hero.copy.done": "已复制",
      "hero.cta.start": "开始使用 →",
      "hero.cta.star": "在 GitHub 加星",
      "hero.stat.cache": "前缀缓存命中率",
      "hero.stat.cost": "相比 Claude Sonnet 4.6 节省",
      "hero.stat.pass": "τ-bench-lite 通过率",

      "term.user":
        "users.ts 里 findByEmail 对大小写敏感导致登录失败，帮我改",
      "term.found":
        "▸ 找到了。findByEmail 直接用 === 比对。改成小写规范化并补一条测试。",
      "term.pending": "▸ 1 处待应用编辑 · /apply 写入 · /discard 丢弃",

      "why.title": "为什么选 Reasonix",
      "why.sub":
        "每个抽象都对应 DeepSeek 的一个具体特性——极低 token 价、R1 推理轨迹、自动前缀缓存、JSON 模式。通用框架把这些机会全留在桌上。",
      "why.cache.title": "缓存优先的循环",
      "why.cache.body":
        "对话日志只追加不重写，前缀字节级稳定，DeepSeek 的自动前缀缓存命中能稳定打到 85–95%，而不是 40%。",
      "why.cost.title": "成本是头等公民",
      "why.cost.body":
        "默认 flash 优先、turn 末尾自动压缩、必要时模型自我升级到 pro。TUI 有实时单轮成本徽章。",
      "why.tui.title": "Ink TUI，不靠浏览器",
      "why.tui.body":
        "完全在终端里。流式预览、斜杠命令、计划审阅、编辑确认弹窗。Windows 顽固终端可启用 plain 模式。",
      "why.mcp.title": "原生 MCP",
      "why.mcp.body":
        "stdio + HTTP+SSE 双传输。长任务有实时进度条。和原生工具一样走缓存安全 + 自动修复管线。",
      "why.safe.title": "编辑可审阅",
      "why.safe.body":
        "编辑以 SEARCH/REPLACE 块呈现，/apply 之前不动磁盘。逐文件 diff 确认、撤销历史、路径沙箱。",
      "why.ctx.title": "百万 token 感知",
      "why.ctx.body":
        "上下文仪表 + 主动压缩、超大工具结果自动修复、贴近上限自动总结兜底。",

      "qs.title": "60 秒快速上手",
      "qs.step1.title": "获取 DeepSeek API Key",
      "qs.step1.body":
        '在 <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener">platform.deepseek.com</a> 注册即送免费额度。',
      "qs.step2.title": "切到项目目录运行",
      "qs.step2.body": "无需安装。",
      "qs.step2.note":
        "首次运行会走 30 秒向导：粘贴 API key → 选预设 → 勾选 MCP 服务器。",
      "qs.step3.title": "让它改代码",
      "qs.step3.body":
        "模型会以 SEARCH/REPLACE 块的形式提出编辑——你不 <code>/apply</code>，磁盘不会被改。",
      "qs.req":
        "需要 Node ≥ 22。支持 macOS、Linux、Windows（PowerShell · Git Bash · Windows Terminal）。任何时候按 <kbd>Esc</kbd> 中断；<code>/help</code> 查看完整命令。",

      "feat.title": "开箱即用",
      "feat.code.title": "结对编程模式",
      "feat.code.body":
        "<code>read_file</code> · <code>write_file</code> · <code>edit_file</code> · <code>search_files</code> · <code>directory_tree</code> · 带只读白名单的 <code>run_command</code>。沙箱限定在启动目录——路径逃逸一律拒绝。支持 plan 模式与逐次编辑确认弹窗。",
      "feat.memory.title": "两层记忆系统",
      "feat.memory.body":
        "可提交的 <code>REASONIX.md</code> 承载团队约定，私人 <code>~/.reasonix/memory/</code> 分全局与按项目两个作用域。模型可通过 <code>remember</code> 工具自行写入。",
      "feat.skills.title": "用户定义的 prompt 包",
      "feat.skills.body":
        "把 <code>SKILL.md</code> 丢进任意位置。名字 + 描述会被钉在前缀里，模型可自动调用，或你用 <code>/skill name</code> 手动触发。",
      "feat.hooks.title": "生命周期钩子",
      "feat.hooks.body":
        "在 <code>PreToolUse</code> · <code>PostToolUse</code> · <code>UserPromptSubmit</code> · <code>Stop</code> 四个点触发 shell 命令，退出码决定放行 / 阻断 / 警告。",
      "feat.mcp.title": "自带工具进来",
      "feat.mcp.body":
        '向导内置目录，或用 <code>--mcp "name=cmd"</code> 直接挂 stdio / HTTP+SSE 服务器。长任务渲染实时进度条。',
      "feat.web.title": "内置联网搜索",
      "feat.web.body":
        "<code>web_search</code> + <code>web_fetch</code>，背靠 Mojeek——无需 key、无需注册，离线 / CI 可关闭。可通过 <code>WebSearchProvider</code> 接口接入自家搜索。",

      "bench.title": "缓存命中率自己也能验证",
      "bench.sub":
        "同一 τ-bench-lite 负载（8 个多轮工具调用任务 × 3 次重复 = 每边 48 次运行），实测 DeepSeek <code>deepseek-chat</code>，唯一变量是前缀稳定性：",
      "bench.col.metric": "指标",
      "bench.col.baseline": "基线（缓存敌对）",
      "bench.col.reasonix": "Reasonix",
      "bench.col.delta": "差值",
      "bench.row.cache": "缓存命中",
      "bench.row.cost": "单任务成本",
      "bench.row.pass": "通过率",
      "bench.repro.intro": "无需消耗 API 额度即可复现：",
      "bench.repro.note":
        "提交进仓库的 JSONL 文件每轮带 <code>usage</code>、<code>cost</code>、<code>prefixHash</code>。Reasonix 的前缀哈希在每次模型调用时都字节稳定。",

      "cli.title": "CLI 速览",
      "cli.code": "针对指定路径的编程模式",
      "cli.chat": "聊天模式（读取已保存配置）",
      "cli.setup": "重新跑配置向导",
      "cli.run": "一次性运行，结果流到 stdout",
      "cli.stats": "跨会话的成本仪表盘",
      "cli.mcp": "探测单个 MCP 服务器",
      "cli.flags.intro": "常用 flag：",
      "cli.f.preset": "模型 + harvest + 分支并行 一键组合",
      "cli.f.model": "显式指定 DeepSeek 模型 ID",
      "cli.f.mcp": "挂载 MCP 服务器（可重复）",
      "cli.f.session": "命名会话",
      "cli.f.noconf": "忽略 ~/.reasonix/config.json（CI 友好）",

      "ctab.title": "准备好了吗？",
      "ctab.sub": "一条 <code>npx</code> 即可开始。沙箱、可审阅、便宜 98%。",
      "ctab.gh": "GitHub 仓库 →",
      "ctab.npm": "npm 包",

      "foot.tag": "Reasonix 只做 DeepSeek，做到底。",
      "foot.col.project": "项目",
      "foot.col.docs": "文档",
      "foot.col.community": "社区",
      "foot.changelog": "更新日志",
      "foot.readme": "英文 README",
      "foot.readme.zh": "中文 README",
      "foot.arch": "架构文档",
      "foot.issues": "问题反馈",
      "foot.discuss": "讨论区",
      "foot.copyright": "© 2026 Reasonix · MIT 协议",
    },
  };

  function safeStorageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function safeStorageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (_) {
      /* ignore */
    }
  }

  function detectLang() {
    const params = new URLSearchParams(window.location.search);
    const queryLang = params.get("lang");
    if (queryLang && SUPPORTED.includes(queryLang)) return queryLang;

    const stored = safeStorageGet(STORAGE_KEY);
    if (stored && SUPPORTED.includes(stored)) return stored;

    const navLang = (navigator.language || navigator.userLanguage || "").toLowerCase();
    if (navLang.startsWith("zh")) return "zh";

    if (Array.isArray(navigator.languages)) {
      for (const l of navigator.languages) {
        if (l && l.toLowerCase().startsWith("zh")) return "zh";
      }
    }

    return DEFAULT_LANG;
  }

  let currentLang = DEFAULT_LANG;
  const langListeners = [];

  // Version is rendered into translation strings via a `{version}` token
  // (see hero.badge). Source of truth is npm — `loadVersion()` fetches
  // it on page load and re-applies translations. Until that resolves
  // we fall back to the most recently cached value, then to a baked-in
  // default. Only places this constant matters: the user is offline AND
  // visits the site for the first time. Bumping it occasionally on
  // major version cuts is fine; the npm fetch handles everything else.
  const VERSION_STORAGE_KEY = "reasonix.version";
  const VERSION_FALLBACK = "0.16";
  const versionListeners = [];
  let currentVersion = VERSION_FALLBACK;

  function applyVersion(v) {
    if (typeof v !== "string" || !v || v === currentVersion) return;
    currentVersion = v;
    safeStorageSet(VERSION_STORAGE_KEY, v);
    applyLang(currentLang); // re-render any `{version}` tokens
    for (const fn of versionListeners) {
      try {
        fn(v);
      } catch (_) {
        /* ignore */
      }
    }
  }

  async function loadVersion() {
    try {
      const r = await fetch("https://registry.npmjs.org/reasonix/latest", {
        cache: "no-cache",
      });
      if (!r.ok) return;
      const data = await r.json();
      if (data && typeof data.version === "string") applyVersion(data.version);
    } catch (_) {
      /* offline / firewall — keep cached or fallback */
    }
  }

  function fillVersion(s) {
    return typeof s === "string" ? s.replace(/\{version\}/g, currentVersion) : s;
  }

  function applyLang(lang) {
    if (!SUPPORTED.includes(lang)) lang = DEFAULT_LANG;
    const changed = lang !== currentLang;
    currentLang = lang;
    const dict = translations[lang];

    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    document.documentElement.setAttribute("data-lang", lang);

    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (dict[key] !== undefined) {
        el.innerHTML = fillVersion(dict[key]);
      }
    });

    document.querySelectorAll("[data-lang-btn]").forEach((btn) => {
      const isActive = btn.getAttribute("data-lang-btn") === lang;
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
    });

    safeStorageSet(STORAGE_KEY, lang);

    if (changed) {
      for (const fn of langListeners) {
        try {
          fn(lang);
        } catch (_) {
          /* ignore */
        }
      }
    }
  }

  // Public API for sibling scripts (term-anim.js).
  window.Reasonix = window.Reasonix || {};
  window.Reasonix.t = function (key) {
    const dict = translations[currentLang] || translations[DEFAULT_LANG];
    return dict[key];
  };
  window.Reasonix.lang = function () {
    return currentLang;
  };
  window.Reasonix.onLangChange = function (fn) {
    if (typeof fn === "function") langListeners.push(fn);
  };
  window.Reasonix.version = function () {
    return currentVersion;
  };
  window.Reasonix.onVersionChange = function (fn) {
    if (typeof fn === "function") versionListeners.push(fn);
  };

  function wireLangButtons() {
    document.querySelectorAll("[data-lang-btn]").forEach((btn) => {
      btn.addEventListener("click", () => {
        applyLang(btn.getAttribute("data-lang-btn"));
      });
    });
  }

  function wireCopyButtons() {
    document.querySelectorAll("[data-copy]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const text = btn.getAttribute("data-copy");
        try {
          await navigator.clipboard.writeText(text);
        } catch (_) {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          try {
            document.execCommand("copy");
          } catch (_) {
            /* ignore */
          }
          document.body.removeChild(ta);
        }
        const lang = document.documentElement.getAttribute("data-lang") || DEFAULT_LANG;
        const original = translations[lang]["hero.copy"] || "Copy";
        const done = translations[lang]["hero.copy.done"] || "Copied";
        btn.textContent = done;
        btn.classList.add("copied");
        setTimeout(() => {
          btn.textContent = original;
          btn.classList.remove("copied");
        }, 1600);
      });
    });
  }

  function init() {
    // Use the cached npm version (if any) so the badge isn't visibly
    // wrong on first paint; fall back to the baked-in default. Then
    // fire off the live fetch — when it resolves, applyVersion()
    // re-applies translations and notifies subscribers (term-anim).
    const cached = safeStorageGet(VERSION_STORAGE_KEY);
    if (typeof cached === "string" && /^\d+\.\d+/.test(cached)) currentVersion = cached;
    applyLang(detectLang());
    wireLangButtons();
    wireCopyButtons();
    loadVersion();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
