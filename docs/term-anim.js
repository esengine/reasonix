// Hero terminal animation — simulates a `reasonix code` session using
// the real TUI rendering primitives:
//   ◇ / ◆ role glyphs + colored vertical accent bars
//   ` ✓ tool_name ` pills (yellow bg, black text)
//   EditBlockRow: rounded cyan border, filename, `- old` red / `+ new` green
//   info rows: dim glyph + dim body (slate)
//
// Reads i18n strings via Reasonix.t(); restarts on language toggle.

(function () {
  "use strict";

  const ROOT_SEL = "[data-anim-root]";
  const REPLAY_SEL = "[data-replay]";

  const tr = (key, fallback) => {
    if (window.Reasonix && typeof window.Reasonix.t === "function") {
      const v = window.Reasonix.t(key);
      if (v !== undefined && v !== null && v !== "") return v;
    }
    return fallback != null ? fallback : key;
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // Brand gradient — same stops as src/cli/ui/theme.ts GRADIENT.
  const GRADIENT = [
    "#5eead4",
    "#67e8f9",
    "#7dd3fc",
    "#93c5fd",
    "#a5b4fc",
    "#c4b5fd",
    "#d8b4fe",
    "#f0abfc",
  ];

  // ──────────────────────────────────────────────────────────────────
  // Header bar — `◈ REASONIX v0.6.0  v4-flash  REVIEW  max  …  turn 1 · /help`
  // ──────────────────────────────────────────────────────────────────
  function buildHeader(turn) {
    const h = el("div", "thead");
    h.innerHTML =
      '<span class="tw-mark">◈</span>' +
      '<span class="tw-name">REASONIX</span>' +
      '<span class="tw-ver">v0.6.0</span>' +
      '<span class="tw-model">v4-flash</span>' +
      '<span class="tw-pill review">REVIEW</span>' +
      '<span class="tw-effort">max</span>' +
      '<span class="tw-spacer"></span>' +
      '<span class="tw-turn">turn ' +
      turn +
      " · /help</span>";
    return h;
  }

  // ──────────────────────────────────────────────────────────────────
  // User row — ◇ glyph (cyan) + cyan vertical accent bar + text.
  // Mirrors EventLog.tsx role="user" render.
  // ──────────────────────────────────────────────────────────────────
  function buildUserRow(text) {
    const row = el("div", "trow trow-user");
    row.innerHTML =
      '<span class="trole role-user">◇</span>' +
      '<span class="tbar-cyan">▎</span>' +
      '<span class="trow-body"></span>';
    row.querySelector(".trow-body").textContent = text;
    return row;
  }

  // Same shape as a user row but the body content is built progressively
  // by the animation. Returns the row + an `input` ref + a `caret` span.
  function buildLiveUserRow() {
    const row = el("div", "trow trow-user trow-live");
    row.innerHTML =
      '<span class="trole role-user">◇</span>' +
      '<span class="tbar-cyan">▎</span>' +
      '<span class="trow-body"><span class="tinput"></span><span class="tcaret">▍</span></span>';
    row._input = row.querySelector(".tinput");
    row._caret = row.querySelector(".tcaret");
    return row;
  }

  // ──────────────────────────────────────────────────────────────────
  // Tool pill row — ` ✓ tool_name `  duration  dim summary  /tool N
  // Yellow bg pill (red bg for errors). Mirrors ToolPill in EventLog.tsx.
  // ──────────────────────────────────────────────────────────────────
  function buildToolRow(name, summary, durationLabel, indexHint) {
    const row = el("div", "trow trow-tool");
    const pill = el("span", "tpill tpill-ok");
    pill.textContent = " ✓ " + name + " ";
    row.appendChild(pill);
    if (durationLabel) {
      row.appendChild(el("span", "tdim", "  " + durationLabel));
    }
    row.appendChild(el("span", "tdim", "  " + summary));
    if (indexHint) {
      row.appendChild(el("span", "tdim tindex", "  /tool " + indexHint));
    }
    return row;
  }

  // ──────────────────────────────────────────────────────────────────
  // Assistant row — ◆ glyph + ` v4-flash ` pill, then a green-bordered
  // body the caller fills with text + (optionally) an EditBlockRow.
  // Returns { row, body } so the caller can append into body.
  // ──────────────────────────────────────────────────────────────────
  function buildAssistantRow() {
    const row = el("div", "trow trow-asst");
    row.innerHTML =
      '<div class="trow-asst-head">' +
      '<span class="trole role-asst">◆</span>' +
      '<span class="tpill tpill-model"> v4-flash </span>' +
      "</div>" +
      '<div class="trow-asst-body">' +
      '<span class="tbar-green">▎</span>' +
      '<div class="trow-asst-content"></div>' +
      "</div>";
    return { row, body: row.querySelector(".trow-asst-content") };
  }

  // ──────────────────────────────────────────────────────────────────
  // EditBlockRow — rounded cyan border, filename in cyan bold, then
  // `- old` red and `+ new` green lines. NO literal SEARCH/REPLACE
  // markers (the model's text format is parsed; only the diff is
  // shown). Mirrors EditBlockRow in markdown.tsx.
  // ──────────────────────────────────────────────────────────────────
  function buildEditBlock(filename, oldLines, newLines) {
    const box = el("div", "tedit");
    const head = el("div", "tedit-head");
    head.appendChild(el("span", "tedit-filename", filename));
    box.appendChild(head);
    const diff = el("div", "tedit-diff");
    box.appendChild(diff);
    return { box, diff, oldLines, newLines };
  }

  // ──────────────────────────────────────────────────────────────────
  // Info row — colored glyph + dim body. Used for pending + applied
  // status lines, mirrors EventLog.tsx role="info".
  // ──────────────────────────────────────────────────────────────────
  function buildInfoRow(glyph, glyphColor, body) {
    const row = el("div", "trow trow-info");
    const g = el("span", "tinfo-glyph", glyph);
    g.style.color = glyphColor;
    row.appendChild(g);
    row.appendChild(el("span", "tdim", " " + body));
    return row;
  }

  // ──────────────────────────────────────────────────────────────────
  // Animate text into a target node, character by character.
  // ──────────────────────────────────────────────────────────────────
  async function typeInto(target, text, perChar, cancelled) {
    for (let i = 0; i < text.length; i++) {
      target.appendChild(document.createTextNode(text[i]));
      const j = perChar * (0.85 + Math.random() * 0.3);
      const ch = text[i];
      const pause = /[，。、；：,.;:]/.test(ch) ? perChar * 4 : 0;
      // eslint-disable-next-line no-await-in-loop
      await sleep(j + pause);
      if (cancelled && cancelled()) return;
    }
  }

  // Cancellation token — interrupts in-flight cycles when the user
  // toggles language or clicks replay so we don't double-render.
  let token = 0;

  async function runCycle(root) {
    const myToken = ++token;
    const cancelled = () => myToken !== token;

    root.classList.remove("trun-fade");
    root.innerHTML = "";

    root.appendChild(buildHeader(1));

    await sleep(400);
    if (cancelled()) return;

    // 1. Live user prompt — types the question, then converts to a
    //    permanent user row on submit.
    const userMsg = tr(
      "term.user",
      "users.ts findByEmail is case-sensitive — login fails"
    );
    const live = buildLiveUserRow();
    root.appendChild(live);
    await sleep(400);
    if (cancelled()) return;
    await typeInto(live._input, userMsg, 32, cancelled);
    if (cancelled()) return;
    await sleep(550);
    live._caret.remove();
    live.classList.add("trow-sent");

    // 2. Tool pills appear one by one. Real summaries come from
    //    summarizeToolResult() in summarize.ts — we hard-code the
    //    representative output for this scene.
    await sleep(380);
    if (cancelled()) return;
    root.appendChild(
      buildToolRow(
        "search_files",
        "matched 2 files: src/users.ts, src/users.test.ts",
        "0.4s",
        "1"
      )
    );
    await sleep(560);
    if (cancelled()) return;
    root.appendChild(
      buildToolRow("read_file", "read src/users.ts (412 chars)", "0.2s", "2")
    );
    await sleep(640);
    if (cancelled()) return;

    // 3. Assistant row — ◆ + model pill, then green-bordered body
    //    containing the streamed text and the EditBlockRow.
    const a = buildAssistantRow();
    root.appendChild(a.row);
    await sleep(280);
    if (cancelled()) return;

    const replyP = el("p", "tmd-p");
    a.body.appendChild(replyP);
    const replyMsg = tr(
      "term.found",
      "Found it. findByEmail uses === directly. Switching to lowercase normalization."
    );
    await typeInto(replyP, replyMsg, 18, cancelled);
    if (cancelled()) return;
    await sleep(360);

    // 4. EditBlockRow — rounded cyan border with filename + colored
    //    diff lines. No SEARCH/REPLACE markers.
    const eb = buildEditBlock(
      "src/users.ts",
      ["  return users.find(u => u.email === email);"],
      [
        "  const needle = email.toLowerCase();",
        "  return users.find(u => u.email.toLowerCase() === needle);",
      ]
    );
    a.body.appendChild(eb.box);
    await sleep(220);
    if (cancelled()) return;

    for (const line of eb.oldLines) {
      const r = el("div", "tdiff tdiff-old", "- " + line);
      eb.diff.appendChild(r);
      // eslint-disable-next-line no-await-in-loop
      await sleep(180);
      if (cancelled()) return;
    }
    for (const line of eb.newLines) {
      const r = el("div", "tdiff tdiff-new", "+ " + line);
      eb.diff.appendChild(r);
      // eslint-disable-next-line no-await-in-loop
      await sleep(180);
      if (cancelled()) return;
    }
    await sleep(420);
    if (cancelled()) return;

    // 5. Pending info row — slate `▸` + dim body. Real text from
    //    formatPendingPreview() in edit-history.ts.
    root.appendChild(
      buildInfoRow(
        "▸",
        "#94a3b8",
        tr(
          "term.pending",
          "1 pending edit block(s) — /apply (or y) to commit · /discard (or n) to drop"
        )
      )
    );
    await sleep(1700);
    if (cancelled()) return;

    // 6. /apply — second user turn. Live row, types `/apply`, then
    //    transforms to a sent row. No tool pills (slash is local).
    const apply = buildLiveUserRow();
    root.appendChild(apply);
    await sleep(420);
    if (cancelled()) return;
    await typeInto(apply._input, "/apply", 75, cancelled);
    if (cancelled()) return;
    await sleep(380);
    apply._caret.remove();
    apply.classList.add("trow-sent");

    // 7. Applied info rows — first the header, then the per-file line.
    //    Mirrors formatEditResults() in edit-history.ts.
    await sleep(420);
    root.appendChild(
      buildInfoRow(
        "▸",
        "#94a3b8",
        "edit blocks: 1/1 applied — /undo to roll back, or `git diff` to review"
      )
    );
    const ok = el("div", "trow trow-info trow-info-detail");
    const gl = el("span", "tinfo-glyph", "✓");
    gl.style.color = "#4ade80";
    ok.appendChild(el("span", "tdim", "  "));
    ok.appendChild(gl);
    ok.appendChild(el("span", "tdim", " applied      src/users.ts"));
    root.appendChild(ok);

    await sleep(2800);
    if (cancelled()) return;

    // 8. Fade and loop.
    root.classList.add("trun-fade");
    await sleep(900);
    if (cancelled()) return;
    runCycle(root);
  }

  // Reduced-motion fallback — paint the final scene without typing.
  function runStatic(root) {
    root.innerHTML = "";
    root.appendChild(buildHeader(1));
    root.appendChild(buildUserRow(tr("term.user", "")));
    root.appendChild(
      buildToolRow(
        "search_files",
        "matched 2 files: src/users.ts, src/users.test.ts",
        "0.4s",
        "1"
      )
    );
    root.appendChild(
      buildToolRow("read_file", "read src/users.ts (412 chars)", "0.2s", "2")
    );
    const a = buildAssistantRow();
    root.appendChild(a.row);
    const p = el("p", "tmd-p");
    p.textContent = tr("term.found", "");
    a.body.appendChild(p);
    const eb = buildEditBlock(
      "src/users.ts",
      ["  return users.find(u => u.email === email);"],
      [
        "  const needle = email.toLowerCase();",
        "  return users.find(u => u.email.toLowerCase() === needle);",
      ]
    );
    a.body.appendChild(eb.box);
    eb.oldLines.forEach((l) =>
      eb.diff.appendChild(el("div", "tdiff tdiff-old", "- " + l))
    );
    eb.newLines.forEach((l) =>
      eb.diff.appendChild(el("div", "tdiff tdiff-new", "+ " + l))
    );
    root.appendChild(buildInfoRow("▸", "#94a3b8", tr("term.pending", "")));
  }

  function init() {
    const root = document.querySelector(ROOT_SEL);
    if (!root) return;

    if (window.Reasonix && typeof window.Reasonix.onLangChange === "function") {
      window.Reasonix.onLangChange(() => runCycle(root));
    }

    document.querySelectorAll(REPLAY_SEL).forEach((btn) => {
      btn.addEventListener("click", () => runCycle(root));
    });

    const prm = window.matchMedia
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
    if (prm && prm.matches) {
      runStatic(root);
      return;
    }

    runCycle(root);
  }

  window.Reasonix = window.Reasonix || {};
  window.Reasonix.term = {
    replay() {
      const root = document.querySelector(ROOT_SEL);
      if (root) runCycle(root);
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
