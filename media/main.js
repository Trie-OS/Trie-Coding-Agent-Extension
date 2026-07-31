"use strict";
(() => {
  // node_modules/lucide/dist/esm/defaultAttributes.js
  var defaultAttributes = {
    xmlns: "http://www.w3.org/2000/svg",
    width: 24,
    height: 24,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 2,
    "stroke-linecap": "round",
    "stroke-linejoin": "round"
  };

  // node_modules/lucide/dist/esm/createElement.js
  var createSVGElement = ([tag, attrs, children]) => {
    const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.keys(attrs).forEach((name) => {
      element.setAttribute(name, String(attrs[name]));
    });
    if (children?.length) {
      children.forEach((child) => {
        const childElement = createSVGElement(child);
        element.appendChild(childElement);
      });
    }
    return element;
  };
  var createElement = (iconNode, customAttrs = {}) => {
    const tag = "svg";
    const attrs = {
      ...defaultAttributes,
      ...customAttrs
    };
    return createSVGElement([tag, attrs, iconNode]);
  };

  // node_modules/lucide/dist/esm/icons/arrow-right.js
  var ArrowRight = [
    ["path", { d: "M5 12h14" }],
    ["path", { d: "m12 5 7 7-7 7" }]
  ];

  // node_modules/lucide/dist/esm/icons/bot.js
  var Bot = [
    ["path", { d: "M12 8V4H8" }],
    ["rect", { width: "16", height: "12", x: "4", y: "8", rx: "2" }],
    ["path", { d: "M2 14h2" }],
    ["path", { d: "M20 14h2" }],
    ["path", { d: "M15 13v2" }],
    ["path", { d: "M9 13v2" }]
  ];

  // node_modules/lucide/dist/esm/icons/file-text.js
  var FileText = [
    ["path", { d: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" }],
    ["path", { d: "M14 2v4a2 2 0 0 0 2 2h4" }],
    ["path", { d: "M10 9H8" }],
    ["path", { d: "M16 13H8" }],
    ["path", { d: "M16 17H8" }]
  ];

  // node_modules/lucide/dist/esm/icons/list-checks.js
  var ListChecks = [
    ["path", { d: "m3 17 2 2 4-4" }],
    ["path", { d: "m3 7 2 2 4-4" }],
    ["path", { d: "M13 6h8" }],
    ["path", { d: "M13 12h8" }],
    ["path", { d: "M13 18h8" }]
  ];

  // node_modules/lucide/dist/esm/icons/message-circle-question.js
  var MessageCircleQuestion = [
    ["path", { d: "M7.9 20A9 9 0 1 0 4 16.1L2 22Z" }],
    ["path", { d: "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" }],
    ["path", { d: "M12 17h.01" }]
  ];

  // media/src/main.ts
  var MODE_ICONS = {
    code: Bot,
    plan: ListChecks,
    ask: MessageCircleQuestion
  };
  (function() {
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById("messages");
    const inputEl = document.getElementById("input");
    const sendBtn = document.getElementById("send-btn");
    const stopBtn = document.getElementById("stop-btn");
    const newBtn = document.getElementById("new-btn");
    const connectBtn = document.getElementById("connect-btn");
    const settingsBtn = document.getElementById("settings-btn");
    const undoBtn = document.getElementById("undo-btn");
    const ctxGauge = document.getElementById("ctx-gauge");
    const composerPlusBtn = document.getElementById("composer-plus");
    const composerPlusMenu = document.getElementById("composer-plus-menu");
    const composerChips = document.getElementById("composer-chips");
    const backendChip = document.getElementById("backend-chip");
    const hybridChip = document.getElementById("hybrid-chip");
    const hybridMenu = document.getElementById("hybrid-menu");
    const hybridMenuEnabled = document.getElementById("hybrid-menu-enabled");
    const hybridModelList = document.getElementById("hybrid-model-list");
    const hybridModelLabel = hybridChip?.querySelector(".hybrid-model-label");
    const toolCards = /* @__PURE__ */ new Map();
    let spinnerEl = null;
    let planningEl = null;
    let pendingHybridGroup = null;
    let activeHybridLabel = "Hybrid";
    let currentMode = "code";
    const EXPLORE_TOOLS = /* @__PURE__ */ new Set([
      "read_file",
      "list_dir",
      "glob",
      "grep",
      "search_symbols",
      "web_search"
    ]);
    function isExploreTool(tool) {
      return EXPLORE_TOOLS.has(tool);
    }
    function basename(relPath) {
      const parts = relPath.split("/");
      return parts[parts.length - 1] || relPath;
    }
    function formatElapsed(ms) {
      const seconds = Math.max(1, Math.round(ms / 1e3));
      if (seconds < 60) return seconds + "s";
      return Math.floor(seconds / 60) + "m " + seconds % 60 + "s";
    }
    let hybridMenuOpen = false;
    function closeHybridMenu() {
      hybridMenuOpen = false;
      if (hybridMenu) hybridMenu.hidden = true;
      hybridChip?.setAttribute("aria-expanded", "false");
    }
    function openHybridMenu() {
      hybridMenuOpen = true;
      if (hybridMenu) hybridMenu.hidden = false;
      hybridChip?.setAttribute("aria-expanded", "true");
    }
    function renderHybridMenu(models, enabled) {
      if (!hybridMenuEnabled || !hybridModelList) return;
      hybridMenuEnabled.checked = enabled;
      hybridModelList.innerHTML = "";
      if (models.length === 0) {
        const empty = document.createElement("div");
        empty.className = "hybrid-menu-empty";
        empty.textContent = "Configure providers in Settings";
        hybridModelList.appendChild(empty);
        return;
      }
      for (const m of models) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "hybrid-menu-item" + (m.active ? " active" : "");
        btn.textContent = m.label;
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          vscode.postMessage({ type: "set-frontier", slot: m.slot, modelIndex: m.modelIndex });
          closeHybridMenu();
        });
        hybridModelList.appendChild(btn);
      }
    }
    if (hybridChip && hybridMenu) {
      hybridChip.addEventListener("click", (e) => {
        e.stopPropagation();
        if (hybridMenuOpen) closeHybridMenu();
        else openHybridMenu();
      });
      hybridMenuEnabled?.addEventListener("change", () => {
        vscode.postMessage({ type: "toggle-hybrid", enabled: hybridMenuEnabled.checked });
      });
      hybridMenu.addEventListener("click", (e) => e.stopPropagation());
      document.addEventListener("click", () => {
        if (hybridMenuOpen) closeHybridMenu();
      });
    }
    let turnSession = null;
    function turnSummaryText(session, finished) {
      const parts = [];
      if (session.editedPaths.size > 0) {
        const n = session.editedPaths.size;
        parts.push("Editing " + n + " file" + (n === 1 ? "" : "s"));
      }
      if (session.commandCount > 0) {
        parts.push("ran " + session.commandCount + " command" + (session.commandCount === 1 ? "" : "s"));
      }
      if (parts.length === 0) {
        return finished ? "Worked for " + formatElapsed(Date.now() - session.startTime) : "Working\u2026";
      }
      return parts.join(", ");
    }
    function refreshTurnSummary() {
      if (!turnSession) return;
      turnSession.labelEl.textContent = turnSummaryText(turnSession, false);
      const trieEl = turnSession.el.querySelector(".turn-trie");
      if (trieEl) {
        trieEl.hidden = turnSession.trieSavedMs < 1;
        if (turnSession.trieSavedMs >= 1) {
          trieEl.textContent = "trie saved " + fmtMs(turnSession.trieSavedMs);
          trieEl.title = "Measured time the prefix-trie symbol index saved vs full content scans this turn";
        }
      }
      if (turnSession.statsEl) {
        const showStats = turnSession.added > 0 || turnSession.deleted > 0;
        turnSession.statsEl.hidden = !showStats;
        if (showStats) {
          const add = turnSession.statsEl.querySelector(".stat-add");
          const del = turnSession.statsEl.querySelector(".stat-del");
          add.textContent = "+" + turnSession.added;
          del.textContent = "\u2212" + turnSession.deleted;
        }
      }
    }
    function ensureTurnSession() {
      if (turnSession) return turnSession;
      const el = document.createElement("details");
      el.className = "turn-session";
      el.open = true;
      const summary = document.createElement("summary");
      summary.className = "turn-summary";
      summary.innerHTML = '<span class="acc-chevron"></span><span class="turn-label">Working\u2026</span><span class="turn-trie" hidden></span><span class="turn-stats" hidden><span class="stat-add"></span> <span class="stat-del"></span></span>';
      el.appendChild(summary);
      const body = document.createElement("div");
      body.className = "turn-body";
      el.appendChild(body);
      messagesEl.appendChild(el);
      turnSession = {
        el,
        body,
        labelEl: summary.querySelector(".turn-label"),
        statsEl: summary.querySelector(".turn-stats"),
        startTime: Date.now(),
        lastEventAt: Date.now(),
        activeGroup: null,
        editedPaths: /* @__PURE__ */ new Set(),
        exploredFiles: /* @__PURE__ */ new Set(),
        exploredActions: 0,
        trieSavedMs: 0,
        added: 0,
        deleted: 0,
        commandCount: 0
      };
      scrollDown();
      return turnSession;
    }
    function closeActiveGroup() {
      if (turnSession) turnSession.activeGroup = null;
    }
    function groupTitle(kind, key, count) {
      if (kind === "explore") {
        if (key === "web-search") return "Web search";
        const n = turnSession?.exploredFiles.size ?? 0;
        if (n > 0) return "Explored " + n + " file" + (n === 1 ? "" : "s");
        const actions = turnSession?.exploredActions ?? count;
        return "Explored \xB7 " + actions;
      }
      if (kind === "edit") {
        return "Edited " + basename(key);
      }
      return "Ran " + count + " command" + (count === 1 ? "" : "s");
    }
    function ensureAccordionGroup(kind, key) {
      const session = ensureTurnSession();
      const active = session.activeGroup;
      if (active && active.kind === kind && active.key === key) return active;
      const el = document.createElement("details");
      el.className = "acc-group acc-" + kind;
      el.open = true;
      const summary = document.createElement("summary");
      summary.className = "acc-summary";
      summary.innerHTML = '<span class="acc-chevron"></span><span class="acc-title"></span><span class="acc-meta"></span>';
      el.appendChild(summary);
      const body = document.createElement("div");
      body.className = "acc-body";
      el.appendChild(body);
      session.body.appendChild(el);
      const group = {
        el,
        body,
        metaEl: summary.querySelector(".acc-meta"),
        kind,
        key,
        count: 0
      };
      summary.querySelector(".acc-title").textContent = groupTitle(kind, key, 0);
      session.activeGroup = group;
      scrollDown();
      return group;
    }
    function bumpGroupMeta(group) {
      group.count += 1;
      group.el.querySelector(".acc-title").textContent = groupTitle(
        group.kind,
        group.key,
        group.count
      );
      if (group.kind === "explore") {
        const n = turnSession?.exploredFiles.size ?? 0;
        group.metaEl.textContent = n > 0 ? String(n) : String(turnSession?.exploredActions ?? group.count);
      } else {
        group.metaEl.textContent = String(group.count);
      }
    }
    function addThoughtRow(group, thought, sinceMs) {
      if (!thought || !thought.trim()) return;
      const row = document.createElement("div");
      row.className = "acc-row thought";
      const prefix = sinceMs >= 800 ? "Thought for " + formatElapsed(sinceMs) : "Thought";
      row.textContent = prefix;
      const detail = document.createElement("div");
      detail.className = "acc-thought";
      detail.textContent = thought;
      group.body.appendChild(row);
      group.body.appendChild(detail);
    }
    function addToolRow(group, id, rowLabel, thought, sinceMs) {
      addThoughtRow(group, thought, sinceMs);
      const row = document.createElement("div");
      row.className = "acc-row tool running";
      row.dataset.id = String(id);
      row.innerHTML = '<span class="acc-status">\xB7</span><span class="acc-label"></span>';
      row.querySelector(".acc-label").textContent = rowLabel;
      group.body.appendChild(row);
      bumpGroupMeta(group);
      return row;
    }
    function trackToolCall(msg) {
      const session = ensureTurnSession();
      const sinceMs = Date.now() - session.lastEventAt;
      session.lastEventAt = Date.now();
      hidePlanning();
      if (msg.linesAdded) session.added += msg.linesAdded;
      if (msg.linesDeleted) session.deleted += msg.linesDeleted;
      let group;
      if (msg.tool === "web_search") {
        group = ensureAccordionGroup("explore", "web-search");
      } else if (isExploreTool(msg.tool)) {
        session.exploredActions += 1;
        if (msg.tool === "read_file" && msg.args) session.exploredFiles.add(msg.args);
        group = ensureAccordionGroup("explore", "explore");
      } else if (msg.tool === "run_command") {
        session.commandCount += 1;
        group = ensureAccordionGroup("command", "command");
      } else if (msg.tool === "edit_file" || msg.tool === "write_file") {
        const key = msg.groupKey || msg.args || msg.tool;
        if (msg.groupKey) session.editedPaths.add(msg.groupKey);
        group = ensureAccordionGroup("edit", key);
      } else {
        closeActiveGroup();
        group = ensureAccordionGroup("edit", msg.tool);
      }
      refreshTurnSummary();
      return addToolRow(group, msg.id, msg.rowLabel, msg.thought, sinceMs);
    }
    let todoCard = null;
    let todoCardSeen = false;
    function renderInlineTodos(todo, done) {
      if (todo.length === 0 && done.length === 0) return;
      const session = ensureTurnSession();
      closeActiveGroup();
      const total = todo.length + done.length;
      if (!todoCard) {
        const el = document.createElement("details");
        el.className = "acc-group acc-todos";
        el.open = true;
        el.innerHTML = '<summary class="acc-summary"><span class="acc-chevron"></span><span class="acc-title">Todos</span><span class="acc-meta"></span></summary><div class="acc-body todo-card-body"></div>';
        session.body.appendChild(el);
        todoCard = el;
      }
      const body = todoCard.querySelector(".todo-card-body");
      const titleEl = todoCard.querySelector(".acc-title");
      const metaEl = todoCard.querySelector(".acc-meta");
      titleEl.textContent = todoCardSeen ? "Updated todos" : "Todos";
      metaEl.textContent = String(total);
      todoCardSeen = true;
      body.innerHTML = "";
      for (const item of done) {
        const row = document.createElement("div");
        row.className = "todo-card-item done";
        row.innerHTML = '<span class="todo-mark">\u2713</span><span class="todo-text"></span>';
        row.querySelector(".todo-text").textContent = item;
        body.appendChild(row);
      }
      for (const item of todo) {
        const row = document.createElement("div");
        row.className = "todo-card-item";
        row.innerHTML = '<span class="todo-mark"></span><span class="todo-text"></span>';
        row.querySelector(".todo-text").textContent = item;
        body.appendChild(row);
      }
      scrollDown();
    }
    function finishTurnSession() {
      if (!turnSession) return;
      refreshTurnSummary();
      turnSession.labelEl.textContent = turnSummaryText(turnSession, true);
      turnSession = null;
      todoCard = null;
      todoCardSeen = false;
      closeActiveGroup();
    }
    function resetTurnSession() {
      turnSession = null;
      todoCard = null;
      todoCardSeen = false;
      closeActiveGroup();
    }
    function showPlanning() {
      hidePlanning();
      const session = ensureTurnSession();
      planningEl = document.createElement("div");
      planningEl.className = "acc-row planning";
      planningEl.textContent = "Planning next moves\u2026";
      session.body.appendChild(planningEl);
      scrollDown();
    }
    function hidePlanning() {
      planningEl?.remove();
      planningEl = null;
    }
    const reviewCards = /* @__PURE__ */ new Map();
    function fileBadge(name) {
      const ext = name.split(".").pop()?.toLowerCase() ?? "";
      if (ext === "ts" || ext === "tsx") return { text: "TS", cls: "ts" };
      if (ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs") return { text: "JS", cls: "js" };
      if (ext === "css" || ext === "scss" || ext === "less") return { text: "#", cls: "css" };
      if (ext === "json") return { text: "{}", cls: "json" };
      if (ext === "md" || ext === "mdx") return { text: "M\u2193", cls: "md" };
      if (ext === "html" || ext === "svg" || ext === "xml") return { text: "<>", cls: "html" };
      if (ext === "py") return { text: "PY", cls: "py" };
      if (ext === "swift") return { text: "SW", cls: "swift" };
      if (["png", "jpg", "jpeg", "gif", "webp", "ico", "icns"].includes(ext)) {
        return { text: "\u25A8", cls: "img" };
      }
      return { text: (ext.slice(0, 2) || "\xB7").toUpperCase(), cls: "other" };
    }
    let pendingUndoSha = null;
    function setComposerUndo(sha, fileCount) {
      pendingUndoSha = sha;
      undoBtn.hidden = !sha;
      if (sha) {
        const hint = fileCount && fileCount > 0 ? `Revert ${fileCount} changed file${fileCount === 1 ? "" : "s"} from the last turn` : "Revert the last turn's file changes";
        undoBtn.title = hint;
      }
    }
    function resolveReviewCard(card, state) {
      card.classList.add("resolved", state);
      if (state === "kept" || state === "undone") setComposerUndo(null);
      const actions = card.querySelector(".review-actions");
      if (actions) {
        actions.innerHTML = "";
        const note = document.createElement("span");
        note.className = "review-resolved-note";
        note.textContent = state === "kept" ? "\u2713 Changes kept" : "\u21BA Changes undone";
        actions.appendChild(note);
      }
    }
    function fmtMs(ms) {
      if (ms < 1) return "<1ms";
      if (ms < 1e3) return Math.round(ms) + "ms";
      return (ms / 1e3).toFixed(1) + "s";
    }
    let ctxUsed = 0;
    let ctxLimit = 0;
    let ctxFlashTimer = null;
    function fmtTokens(n) {
      if (n < 1e3) return String(n);
      return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
    }
    function renderCtxGauge() {
      if (ctxLimit <= 0) {
        ctxGauge.hidden = true;
        return;
      }
      const pct = Math.min(999, Math.round(ctxUsed / ctxLimit * 100));
      ctxGauge.hidden = false;
      ctxGauge.classList.remove("compacting");
      ctxGauge.classList.toggle("warn", pct >= 75 && pct < 90);
      ctxGauge.classList.toggle("hot", pct >= 90);
      ctxGauge.textContent = fmtTokens(ctxUsed) + " \xB7 " + pct + "%";
      ctxGauge.title = "Context: " + ctxUsed.toLocaleString() + " / " + ctxLimit.toLocaleString() + " tokens (" + pct + "%) \u2014 click to compact memory now";
    }
    ctxGauge.addEventListener("click", () => {
      if (isBusy || ctxGauge.classList.contains("compacting")) return;
      vscode.postMessage({ type: "compact" });
    });
    function renderReviewCard(sha, files) {
      const card = document.createElement("div");
      card.className = "review-card";
      reviewCards.set(sha, card);
      const totalAdded = files.reduce((sum, f) => sum + f.added, 0);
      const totalDeleted = files.reduce((sum, f) => sum + f.deleted, 0);
      const head = document.createElement("div");
      head.className = "review-head";
      const title = document.createElement("span");
      title.className = "review-title";
      title.textContent = files.length + " File" + (files.length === 1 ? "" : "s") + " Changed";
      const reviewBtn = document.createElement("button");
      reviewBtn.className = "review-open";
      reviewBtn.textContent = "Review";
      reviewBtn.title = "Open a before \u2194 after diff for each changed file (+" + totalAdded + " \u2212" + totalDeleted + ")";
      reviewBtn.addEventListener("click", () => {
        for (const file of files) {
          vscode.postMessage({ type: "open-diff", sha, path: file.path });
        }
      });
      head.appendChild(title);
      head.appendChild(reviewBtn);
      card.appendChild(head);
      const list = document.createElement("div");
      list.className = "review-files";
      const VISIBLE_FILES = 4;
      for (const [index, file] of files.entries()) {
        const parts = file.path.split("/");
        const name = parts[parts.length - 1];
        const badge = fileBadge(name);
        const row = document.createElement("button");
        row.className = "review-file";
        if (index >= VISIBLE_FILES) row.classList.add("overflow");
        row.title = "Open diff: " + file.path;
        const badgeEl = document.createElement("span");
        badgeEl.className = "file-badge " + badge.cls;
        badgeEl.textContent = badge.text;
        const nameEl = document.createElement("span");
        nameEl.className = "file-name";
        nameEl.textContent = name;
        const statsEl = document.createElement("span");
        statsEl.className = "file-stats";
        if (file.added > 0) {
          const add = document.createElement("span");
          add.className = "stat-add";
          add.textContent = "+" + file.added;
          statsEl.appendChild(add);
        }
        if (file.deleted > 0) {
          const del = document.createElement("span");
          del.className = "stat-del";
          del.textContent = "\u2212" + file.deleted;
          statsEl.appendChild(del);
        }
        row.appendChild(badgeEl);
        row.appendChild(nameEl);
        row.appendChild(statsEl);
        row.addEventListener("click", () => {
          vscode.postMessage({ type: "open-diff", sha, path: file.path });
        });
        list.appendChild(row);
      }
      if (files.length > VISIBLE_FILES) {
        const more = document.createElement("button");
        more.className = "review-more";
        const hiddenCount = files.length - VISIBLE_FILES;
        more.innerHTML = '<span class="review-more-dots">\u22EF</span><span class="review-more-label"></span>';
        more.querySelector(".review-more-label").textContent = "Show " + hiddenCount + " more";
        more.addEventListener("click", () => {
          const expanded = card.classList.toggle("expanded");
          more.querySelector(".review-more-label").textContent = expanded ? "Show fewer" : "Show " + hiddenCount + " more";
          scrollDown();
        });
        list.appendChild(more);
      }
      card.appendChild(list);
      const actions = document.createElement("div");
      actions.className = "review-actions";
      const undoBtn2 = document.createElement("button");
      undoBtn2.className = "review-btn undo";
      undoBtn2.textContent = "\u21BA Undo";
      undoBtn2.title = "Revert the workspace to how it was before this turn";
      undoBtn2.addEventListener("click", () => {
        vscode.postMessage({ type: "restore", sha });
      });
      const keepBtn = document.createElement("button");
      keepBtn.className = "review-btn keep";
      keepBtn.textContent = "\u2713 Keep";
      keepBtn.title = "Accept these changes";
      keepBtn.addEventListener("click", () => {
        resolveReviewCard(card, "kept");
      });
      actions.appendChild(undoBtn2);
      actions.appendChild(keepBtn);
      card.appendChild(actions);
      messagesEl.appendChild(card);
      scrollDown();
    }
    function hybridModelName() {
      return activeHybridLabel === "Hybrid" ? "Hybrid" : "Hybrid \xB7 " + activeHybridLabel;
    }
    function hybridCheckpointLabel(checkpoint, phase) {
      if (phase === "checking") return "Checking with " + hybridModelName();
      const action = {
        decompose: "Planned with",
        stuck_hint: "Guidance from",
        final_review: "Reviewed with",
        uncertainty: "Guidance from",
        self_grade: "Reviewed with"
      };
      return (action[checkpoint] ?? "Checked with") + " " + hybridModelName();
    }
    function renderHybridSubtasks(body, subtasks, rationale) {
      body.innerHTML = "";
      const ol = document.createElement("ol");
      ol.className = "hybrid-subtasks";
      for (const task of subtasks) {
        const li = document.createElement("li");
        li.textContent = task;
        ol.appendChild(li);
      }
      body.appendChild(ol);
      if (rationale?.trim()) {
        const note = document.createElement("div");
        note.className = "hybrid-plan-note";
        note.textContent = rationale.trim();
        body.appendChild(note);
      }
    }
    function createHybridGroup(checkpoint) {
      const session = ensureTurnSession();
      closeActiveGroup();
      const el = document.createElement("details");
      el.className = "acc-group acc-hybrid checking";
      el.open = true;
      el.dataset.checkpoint = checkpoint;
      const summary = document.createElement("summary");
      summary.className = "acc-summary";
      summary.innerHTML = '<span class="acc-chevron"></span><span class="acc-title"></span><span class="acc-meta"></span>';
      el.appendChild(summary);
      const body = document.createElement("div");
      body.className = "acc-body";
      el.appendChild(body);
      session.body.appendChild(el);
      scrollDown();
      return {
        el,
        titleEl: summary.querySelector(".acc-title"),
        metaEl: summary.querySelector(".acc-meta"),
        body,
        checkpoint
      };
    }
    function showHybridCheck(checkpoint) {
      hideSpinner();
      pendingHybridGroup = createHybridGroup(checkpoint);
      pendingHybridGroup.titleEl.textContent = hybridCheckpointLabel(checkpoint, "checking");
      pendingHybridGroup.metaEl.textContent = "";
      pendingHybridGroup.body.innerHTML = "";
      if (checkpoint === "decompose") {
        const row = document.createElement("div");
        row.className = "acc-hybrid-note";
        row.textContent = "Breaking the task into steps\u2026";
        pendingHybridGroup.body.appendChild(row);
      }
    }
    function showHybridPlan(subtasks, rationale) {
      hideSpinner();
      let group = pendingHybridGroup;
      if (!group || group.checkpoint !== "decompose") {
        group = createHybridGroup("decompose");
        pendingHybridGroup = group;
      }
      group.el.classList.remove("checking");
      group.el.classList.add("plan");
      group.titleEl.textContent = hybridCheckpointLabel("decompose", "guide");
      group.metaEl.textContent = String(subtasks.length);
      renderHybridSubtasks(group.body, subtasks, rationale);
      pendingHybridGroup = null;
      scrollDown();
    }
    function settleHybridCheck(checkpoint) {
      const group = pendingHybridGroup;
      if (!group) return;
      group.el.classList.remove("checking");
      if (group.el.classList.contains("plan")) {
        pendingHybridGroup = null;
        return;
      }
      const el = group.el;
      pendingHybridGroup = null;
      setTimeout(() => {
        if (el.classList.contains("guide") || el.classList.contains("plan")) return;
        if (el.querySelector(".acc-hybrid-note, .hybrid-subtasks")) return;
        el.remove();
      }, 0);
    }
    function showHybridGuide(checkpoint, verdict, text) {
      hideSpinner();
      let group = pendingHybridGroup;
      if (!group || group.checkpoint !== checkpoint) {
        const waiting = turnSession?.body.querySelectorAll(
          ".acc-hybrid:not(.guide)"
        );
        const last = waiting?.[waiting.length - 1];
        if (last) {
          group = {
            el: last,
            titleEl: last.querySelector(".acc-title"),
            metaEl: last.querySelector(".acc-meta"),
            body: last.querySelector(".acc-body"),
            checkpoint
          };
        }
      }
      if (!group) group = createHybridGroup(checkpoint);
      group.el.classList.remove("checking");
      group.el.classList.add("guide");
      group.titleEl.textContent = hybridCheckpointLabel(checkpoint, "guide");
      group.metaEl.textContent = verdict === "looks_good" ? "\u2713" : "!";
      group.body.innerHTML = "";
      const note = document.createElement("div");
      note.className = "acc-hybrid-note";
      note.textContent = text.trim() ? text : verdict === "looks_good" ? "Looks good \u2014 no changes requested." : "The reviewer flagged a concern but returned no details.";
      group.body.appendChild(note);
      pendingHybridGroup = null;
      scrollDown();
    }
    function clearHybridGroups() {
      pendingHybridGroup = null;
      for (const el of Array.from(document.querySelectorAll(".acc-hybrid"))) {
        el.remove();
      }
    }
    function mountModeIcons() {
      for (const btn of document.querySelectorAll("#mode-picker .mode")) {
        const mode = btn.dataset.mode;
        if (!mode || !(mode in MODE_ICONS)) continue;
        btn.querySelector(".mode-icon")?.remove();
        const svg = createElement(MODE_ICONS[mode], {
          width: 13,
          height: 13,
          "stroke-width": 2,
          class: "mode-icon"
        });
        btn.prepend(svg);
      }
    }
    mountModeIcons();
    const modeButtons = Array.from(document.querySelectorAll("#mode-picker .mode"));
    for (const btn of modeButtons) {
      btn.addEventListener("click", () => {
        setMode(btn.dataset.mode || "code");
      });
    }
    function hideWelcome() {
      document.getElementById("welcome")?.classList.add("hidden");
    }
    function showWelcome() {
      document.getElementById("welcome")?.classList.remove("hidden");
    }
    function scrollDown() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    function addBubble(className, text) {
      const el = document.createElement("div");
      el.className = "bubble " + className;
      el.textContent = text;
      messagesEl.appendChild(el);
      scrollDown();
      return el;
    }
    function linkifyText(text) {
      const fragment = document.createDocumentFragment();
      const urlRe = /https?:\/\/[^\s<>"')\]]+/g;
      let last = 0;
      let match;
      while ((match = urlRe.exec(text)) !== null) {
        if (match.index > last) fragment.appendChild(document.createTextNode(text.slice(last, match.index)));
        const a = document.createElement("a");
        a.href = match[0];
        a.textContent = match[0];
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        fragment.appendChild(a);
        last = match.index + match[0].length;
      }
      if (last < text.length) fragment.appendChild(document.createTextNode(text.slice(last)));
      return fragment;
    }
    function addReply(text, failed = false) {
      const el = document.createElement("div");
      el.className = "reply" + (failed ? " failed" : "");
      el.appendChild(linkifyText(text));
      messagesEl.appendChild(el);
      scrollDown();
      return el;
    }
    function showSpinner() {
      hideSpinner();
      showPlanning();
    }
    function hideSpinner() {
      hidePlanning();
      spinnerEl?.remove();
      spinnerEl = null;
    }
    let isBusy = false;
    let workElsewhere = 0;
    let backgroundWorkEl = null;
    let multitaskMode = false;
    let queueCollapsed = true;
    let queueStartingId = null;
    const queue = [];
    let multitaskTasks = [];
    let queueCard = null;
    let activeModeChipEl = null;
    let multitaskChipEl = null;
    let multitaskActivityEl = null;
    let finishedSubagentsEl = null;
    const multitaskRunRows = /* @__PURE__ */ new Map();
    const composerEl = document.getElementById("composer");
    let plusMenuOpen = false;
    const MULTITASK_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="6.25" cy="9" r="3.75"/><circle cx="9.75" cy="7" r="3.75"/></svg>';
    function renderBackgroundWork() {
      backgroundWorkEl?.remove();
      backgroundWorkEl = null;
      if (workElsewhere <= 0) return;
      backgroundWorkEl = document.createElement("div");
      backgroundWorkEl.className = "notice-row background-work";
      backgroundWorkEl.textContent = workElsewhere === 1 ? "Work continues in another chat." : `Work continues in ${workElsewhere} other chats.`;
      messagesEl.insertBefore(backgroundWorkEl, messagesEl.firstChild);
    }
    function closePlusMenu() {
      plusMenuOpen = false;
      composerPlusMenu.hidden = true;
      composerPlusBtn.setAttribute("aria-expanded", "false");
    }
    function openPlusMenu() {
      plusMenuOpen = true;
      composerPlusMenu.hidden = false;
      composerPlusBtn.setAttribute("aria-expanded", "true");
      renderPlusMenu();
    }
    function renderPlusMenu() {
      for (const item of composerPlusMenu.querySelectorAll(".plus-menu-item")) {
        const pick = item.dataset.pick;
        const check = item.querySelector(".plus-menu-check");
        const active = pick === "multitask" ? multitaskMode : pick === currentMode;
        check.hidden = !active;
      }
    }
    function setMode(mode) {
      if (mode !== "code" && multitaskMode) disableMultitask();
      currentMode = mode;
      for (const btn of modeButtons) {
        const active = btn.dataset.mode === mode;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-pressed", String(active));
      }
      renderActiveModeChip();
      renderPlusMenu();
      updateComposerPlaceholder();
    }
    function renderActiveModeChip() {
      activeModeChipEl?.remove();
      activeModeChipEl = null;
      if (currentMode === "code") return;
      const label = currentMode === "plan" ? "Plan" : "Ask";
      const chip = document.createElement("span");
      chip.className = "composer-mode-chip";
      chip.title = currentMode === "plan" ? "Read-only exploration that returns a plan" : "Ask a read-only question about the codebase";
      const icon = createElement(MODE_ICONS[currentMode], {
        width: 11,
        height: 11,
        "stroke-width": 2
      });
      const text = document.createElement("span");
      text.className = "composer-mode-chip-label";
      text.textContent = label;
      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "composer-mode-chip-dismiss";
      dismiss.setAttribute("aria-label", `Turn off ${label}`);
      dismiss.textContent = "\xD7";
      dismiss.addEventListener("click", () => setMode("code"));
      chip.appendChild(icon);
      chip.appendChild(text);
      chip.appendChild(dismiss);
      composerChips.insertBefore(chip, multitaskChipEl);
      activeModeChipEl = chip;
    }
    function updateComposerChrome() {
      stopBtn.hidden = !isBusy || multitaskMode;
      sendBtn.hidden = false;
      undoBtn.disabled = isBusy || !pendingUndoSha;
    }
    function truncatePreview(text, max = 72) {
      const oneLine = text.replace(/\s+/g, " ").trim();
      return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + "\u2026";
    }
    function updateComposerPlaceholder() {
      if (multitaskMode) {
        inputEl.placeholder = "Coordinate parallel work\u2026";
        return;
      }
      inputEl.placeholder = currentMode === "plan" ? "Describe what you want \u2014 the agent explores read-only and returns a plan\u2026" : currentMode === "ask" ? "Ask a question about this codebase (read-only)\u2026" : "Describe a task or ask a question\u2026";
    }
    function enableMultitask() {
      if (multitaskMode) return;
      if (currentMode !== "code") setMode("code");
      multitaskMode = true;
      queueCollapsed = true;
      renderMultitaskChip();
      renderMultitaskActivity();
      renderQueue();
      renderPlusMenu();
      updateComposerPlaceholder();
      updateComposerChrome();
      if (!isBusy && queue.length > 0) drainQueue();
    }
    function disableMultitask() {
      multitaskMode = false;
      queueStartingId = null;
      renderMultitaskChip();
      renderMultitaskActivity();
      renderQueue();
      renderPlusMenu();
      updateComposerPlaceholder();
      updateComposerChrome();
    }
    function renderMultitaskChip() {
      if (!multitaskMode) {
        multitaskChipEl?.remove();
        multitaskChipEl = null;
        composerEl.classList.remove("multitask-active");
        return;
      }
      composerEl.classList.add("multitask-active");
      if (!multitaskChipEl) {
        multitaskChipEl = document.createElement("span");
        multitaskChipEl.className = "composer-mode-chip multitask";
        multitaskChipEl.title = "Run isolated background coding agents safely, one at a time";
        multitaskChipEl.innerHTML = MULTITASK_ICON + '<span class="composer-mode-chip-label">Multitask</span><button type="button" class="composer-mode-chip-dismiss" aria-label="Turn off Multitask">\xD7</button>';
        multitaskChipEl.querySelector(".composer-mode-chip-dismiss")?.addEventListener("click", () => {
          disableMultitask();
        });
        composerChips.appendChild(multitaskChipEl);
      }
    }
    function multitaskActivityStatus() {
      const running = multitaskTasks.filter((task) => task.status === "running").length;
      const waiting = multitaskTasks.filter((task) => task.status === "waiting").length;
      if (running && waiting) return `${running} working \xB7 ${waiting} waiting`;
      if (running) return `${running} working`;
      if (waiting) return `${waiting} starting up`;
      return "Planning next moves\u2026";
    }
    function renderMultitaskActivity() {
      const active = multitaskTasks.some((task) => task.status === "waiting" || task.status === "running");
      const show = multitaskMode && active;
      if (!show) {
        multitaskActivityEl?.remove();
        multitaskActivityEl = null;
        return;
      }
      if (!multitaskActivityEl) {
        multitaskActivityEl = document.createElement("div");
        multitaskActivityEl.id = "multitask-activity";
        multitaskActivityEl.className = "multitask-activity";
        multitaskActivityEl.innerHTML = '<span class="multitask-badge">Multitask</span><span class="multitask-activity-status"></span>';
        messagesEl.insertBefore(multitaskActivityEl, messagesEl.firstChild);
      }
      const status = multitaskActivityEl.querySelector(".multitask-activity-status");
      status.textContent = multitaskActivityStatus();
      scrollDown();
    }
    function queueCardStatus() {
      if (multitaskTasks.some((task) => task.status === "running")) return "Working\u2026";
      if (multitaskTasks.some((task) => task.status === "waiting")) return "Starting up";
      return "Multitask";
    }
    function multitaskStatusLabel(status) {
      if (status === "running") return "Working";
      if (status === "completed") return "Done";
      if (status === "failed") return "Failed";
      if (status === "cancelled") return "Cancelled";
      if (status === "interrupted") return "Interrupted";
      return "Starting up";
    }
    function multitaskRunStatus(task) {
      if (task.status !== "waiting") return multitaskStatusLabel(task.status);
      const hasRunningTask = multitaskTasks.some((candidate) => candidate.status === "running");
      const firstWaitingTask = multitaskTasks.find((candidate) => candidate.status === "waiting");
      return !hasRunningTask && firstWaitingTask?.id === task.id ? "Starting up" : "Waiting for model/subagent";
    }
    function isFinishedMultitaskStatus(status) {
      return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted";
    }
    function multitaskElapsed(task) {
      if (task.startedAt === void 0 || task.finishedAt === void 0) return "";
      return formatElapsed(Math.max(0, task.finishedAt - task.startedAt));
    }
    function renderFinishedSubagents() {
      const finished = multitaskTasks.filter((task) => isFinishedMultitaskStatus(task.status));
      if (finished.length === 0) {
        finishedSubagentsEl?.remove();
        finishedSubagentsEl = null;
        return;
      }
      if (!finishedSubagentsEl) {
        finishedSubagentsEl = document.createElement("details");
        finishedSubagentsEl.className = "finished-subagents";
        finishedSubagentsEl.innerHTML = '<summary class="finished-subagents-summary"><span class="acc-chevron"></span><span class="finished-subagents-title"></span></summary><div class="finished-subagents-body"></div>';
        messagesEl.appendChild(finishedSubagentsEl);
      }
      const title = finishedSubagentsEl.querySelector(".finished-subagents-title");
      title.textContent = `Finished ${finished.length} subagent${finished.length === 1 ? "" : "s"}`;
      const body = finishedSubagentsEl.querySelector(".finished-subagents-body");
      const expandedIds = new Set(
        Array.from(body.querySelectorAll(".finished-subagent-row[open]")).map((row) => row.dataset.id).filter((id) => !!id)
      );
      body.innerHTML = "";
      for (const task of finished) {
        const row = document.createElement("details");
        row.className = `finished-subagent-row ${task.status}`;
        row.dataset.id = task.id;
        row.open = expandedIds.has(task.id);
        const summary = document.createElement("summary");
        summary.innerHTML = '<span class="finished-subagent-indicator" aria-hidden="true"></span><span class="finished-subagent-copy"><span class="finished-subagent-title"></span><span class="finished-subagent-result-preview"></span></span><span class="finished-subagent-meta"></span><span class="acc-chevron"></span>';
        summary.querySelector(".finished-subagent-indicator").textContent = task.status === "completed" ? "\u2713" : task.status === "failed" ? "\xD7" : "\xB7";
        summary.querySelector(".finished-subagent-title").textContent = truncatePreview(task.text, 72) || "Subagent";
        const result = task.result?.trim() ?? "";
        const preview = summary.querySelector(".finished-subagent-result-preview");
        preview.textContent = truncatePreview(result, 110);
        preview.hidden = !result;
        const elapsed = multitaskElapsed(task);
        summary.querySelector(".finished-subagent-meta").textContent = multitaskStatusLabel(task.status) + (elapsed ? ` \xB7 ${elapsed}` : "");
        row.appendChild(summary);
        const detail = document.createElement("div");
        detail.className = "finished-subagent-detail";
        const promptLabel = document.createElement("div");
        promptLabel.className = "finished-subagent-detail-label";
        promptLabel.textContent = "Prompt";
        const prompt = document.createElement("div");
        prompt.className = "finished-subagent-detail-text";
        prompt.textContent = task.text;
        detail.appendChild(promptLabel);
        detail.appendChild(prompt);
        if (result) {
          const resultLabel = document.createElement("div");
          resultLabel.className = "finished-subagent-detail-label";
          resultLabel.textContent = task.status === "failed" ? "Error" : "Result";
          const resultText = document.createElement("div");
          resultText.className = "finished-subagent-detail-text result";
          resultText.textContent = result;
          detail.appendChild(resultLabel);
          detail.appendChild(resultText);
        }
        row.appendChild(detail);
        body.appendChild(row);
      }
    }
    function syncMultitaskRunRows() {
      const liveTasks = multitaskTasks.filter(
        (task) => task.status === "waiting" || task.status === "running"
      );
      const liveIds = new Set(liveTasks.map((task) => task.id));
      for (const [id, row] of multitaskRunRows) {
        if (liveIds.has(id)) continue;
        row.remove();
        multitaskRunRows.delete(id);
      }
      for (const task of liveTasks) {
        let row = multitaskRunRows.get(task.id);
        if (!row) {
          row = document.createElement("details");
          row.className = "multitask-run-row";
          row.innerHTML = '<summary><span class="multitask-run-indicator" aria-hidden="true"><span class="multitask-run-dots"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span><span class="multitask-run-result"></span></span><span class="multitask-run-copy"><span class="multitask-run-title"></span><span class="multitask-run-status"></span></span></summary><div class="multitask-run-prompt"></div>';
          const steer2 = document.createElement("button");
          steer2.type = "button";
          steer2.className = "multitask-steer";
          steer2.title = "Continue this task in the active subagent";
          steer2.setAttribute("aria-label", "Continue this waiting task in the active subagent");
          steer2.appendChild(
            createElement(ArrowRight, {
              width: 14,
              height: 14,
              "stroke-width": 2,
              "aria-hidden": "true"
            })
          );
          steer2.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            vscode.postMessage({ type: "multitask-steer", id: task.id });
          });
          row.querySelector("summary")?.appendChild(steer2);
          messagesEl.appendChild(row);
          multitaskRunRows.set(task.id, row);
        }
        row.className = "multitask-run-row " + task.status;
        row.querySelector(".multitask-run-title").textContent = truncatePreview(task.text, 64) || "New subagent";
        row.querySelector(".multitask-run-status").textContent = multitaskRunStatus(task);
        row.querySelector(".multitask-run-prompt").textContent = task.text;
        const steer = row.querySelector(".multitask-steer");
        steer.hidden = task.status !== "waiting" || !multitaskTasks.some((candidate) => candidate.status === "running");
        row.querySelector(".multitask-run-result").textContent = "";
      }
      renderFinishedSubagents();
      scrollDown();
    }
    function dispatch(text, mode) {
      isBusy = true;
      hideWelcome();
      addBubble("user", text);
      showSpinner();
      renderMultitaskActivity();
      vscode.postMessage({ type: "send", text, mode });
    }
    function drainQueue() {
      if (isBusy || queue.length === 0) return;
      const next = queue[0];
      if (!next) return;
      const launch = () => {
        if (queue[0]?.id !== next.id) {
          queueStartingId = null;
          renderQueue();
          renderMultitaskActivity();
          return;
        }
        queue.shift();
        queueStartingId = null;
        renderQueue();
        renderMultitaskActivity();
        dispatch(next.text, next.mode);
      };
      if (multitaskMode) {
        queueStartingId = next.id;
        renderQueue();
        renderMultitaskActivity();
        setTimeout(launch, 450);
      } else {
        launch();
      }
    }
    function sendQueuedNow() {
      if (queue.length === 0) return;
      vscode.postMessage({ type: "stop" });
    }
    function closeQueueMenu() {
      queueCard?.querySelector(".queue-menu")?.remove();
    }
    function renderQueue() {
      const providerTasks = multitaskTasks.filter((task) => task.status === "waiting" || task.status === "running").slice(-8).reverse();
      const showCard = multitaskMode ? providerTasks.length > 0 : queue.length > 0;
      if (!showCard) {
        queueCard?.remove();
        queueCard = null;
        closeQueueMenu();
        renderMultitaskActivity();
        return;
      }
      if (!queueCard) {
        queueCard = document.createElement("div");
        queueCard.id = "queue-card";
        queueCard.className = "multitask-card";
        composerEl.parentElement?.insertBefore(queueCard, composerEl);
      }
      queueCard.classList.toggle("collapsed", queueCollapsed);
      queueCard.classList.toggle("multitask-mode", multitaskMode);
      queueCard.classList.toggle("draining", isBusy || queueStartingId !== null);
      queueCard.innerHTML = "";
      const head = document.createElement("div");
      head.className = "multitask-card-head";
      const activeCount = multitaskTasks.filter(
        (task) => task.status === "waiting" || task.status === "running"
      ).length;
      const left = document.createElement("div");
      left.className = "multitask-card-left";
      if (multitaskMode && queueCollapsed) {
        const dots = document.createElement("span");
        dots.className = "multitask-pill-dots";
        dots.setAttribute("aria-hidden", "true");
        dots.innerHTML = "<i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i>";
        const separator = document.createElement("span");
        separator.className = "multitask-pill-separator";
        separator.textContent = "\xB7";
        left.appendChild(dots);
        left.appendChild(separator);
      }
      const count = document.createElement("span");
      count.className = "multitask-count";
      if (multitaskMode) {
        count.textContent = queueCollapsed ? activeCount > 0 ? `${activeCount} Working` : "Recent agents" : activeCount > 0 ? `${activeCount} Active` : "Recent agents";
      } else {
        count.textContent = queue.length === 1 ? "1 Queued" : `${queue.length} Queued`;
      }
      const hint = document.createElement("span");
      hint.className = "multitask-send-hint";
      hint.textContent = multitaskMode ? "Background agents" : "\u23CE to send next";
      hint.title = multitaskMode ? "Tasks run one at a time to protect the local model and workspace" : "Press Enter on an empty composer to send the next queued task now";
      left.appendChild(count);
      if (!multitaskMode || !queueCollapsed) left.appendChild(hint);
      const right = document.createElement("div");
      right.className = "multitask-card-right";
      if (multitaskMode && !queueCollapsed && multitaskTasks.some((task) => task.status === "waiting" || task.status === "running")) {
        const spinner = document.createElement("span");
        spinner.className = "multitask-spinner";
        spinner.setAttribute("aria-hidden", "true");
        const status = document.createElement("span");
        status.className = "multitask-card-status";
        status.textContent = queueCardStatus();
        right.appendChild(spinner);
        right.appendChild(status);
      }
      if (multitaskMode && !queueCollapsed && activeCount > 0) {
        const stopAll = document.createElement("button");
        stopAll.type = "button";
        stopAll.className = "multitask-stop-all";
        stopAll.title = "Stop all background agents";
        stopAll.setAttribute("aria-label", "Stop all background agents");
        stopAll.textContent = "Stop All";
        stopAll.addEventListener("click", (event) => {
          event.stopPropagation();
          vscode.postMessage({ type: "multitask-cancel-all" });
        });
        right.appendChild(stopAll);
      }
      const collapse = document.createElement("button");
      collapse.type = "button";
      collapse.className = "multitask-collapse";
      collapse.setAttribute("aria-expanded", String(!queueCollapsed));
      collapse.title = queueCollapsed ? "Show background agents" : "Collapse background agents";
      collapse.setAttribute(
        "aria-label",
        queueCollapsed ? "Show background agents" : "Collapse background agents"
      );
      if (multitaskMode && !queueCollapsed) {
        collapse.classList.add("multitask-panel-close");
        collapse.textContent = "\xD7";
      } else {
        collapse.innerHTML = '<span class="multitask-collapse-chevron"></span>';
      }
      collapse.addEventListener("click", (event) => {
        event.stopPropagation();
        queueCollapsed = !queueCollapsed;
        renderQueue();
      });
      if (!multitaskMode || !queueCollapsed) right.appendChild(collapse);
      head.appendChild(left);
      head.appendChild(right);
      if (multitaskMode && queueCollapsed) {
        head.tabIndex = 0;
        head.setAttribute("role", "button");
        head.setAttribute("aria-expanded", "false");
        head.setAttribute("aria-label", `Show background agents, ${count.textContent}`);
        const expand = () => {
          queueCollapsed = false;
          renderQueue();
        };
        head.addEventListener("click", expand);
        head.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          expand();
        });
      }
      queueCard.appendChild(head);
      const body = document.createElement("div");
      body.className = "multitask-card-body";
      const rows = multitaskMode ? providerTasks : queue;
      rows.forEach((item) => {
        const row = document.createElement("div");
        row.className = "multitask-item";
        const providerTask = "status" in item ? item : null;
        const status = providerTask ? providerTask.status : "queued";
        row.classList.add(status);
        const iconWrap = document.createElement("span");
        iconWrap.className = "multitask-item-icon";
        iconWrap.appendChild(
          createElement(FileText, {
            width: 13,
            height: 13,
            "stroke-width": 2
          })
        );
        const text = document.createElement("span");
        text.className = "multitask-item-text";
        text.textContent = truncatePreview(item.text);
        text.title = item.text;
        const statusEl = document.createElement("span");
        statusEl.className = "multitask-item-status";
        statusEl.textContent = providerTask ? multitaskRunStatus(providerTask) : "Queued";
        const steer = document.createElement("button");
        steer.type = "button";
        steer.className = "multitask-steer";
        steer.title = "Continue this task in the active subagent";
        steer.setAttribute("aria-label", "Continue this waiting task in the active subagent");
        steer.appendChild(
          createElement(ArrowRight, {
            width: 14,
            height: 14,
            "stroke-width": 2,
            "aria-hidden": "true"
          })
        );
        steer.hidden = !providerTask || providerTask.status !== "waiting" || !multitaskTasks.some((candidate) => candidate.status === "running");
        steer.addEventListener("click", (event) => {
          event.stopPropagation();
          if (providerTask) vscode.postMessage({ type: "multitask-steer", id: providerTask.id });
        });
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "multitask-item-remove";
        remove.title = providerTask ? status === "running" ? "Cancel active subagent" : "Cancel waiting subagent" : "Remove from queue";
        remove.setAttribute("aria-label", remove.title);
        remove.textContent = "\xD7";
        remove.hidden = status !== "queued" && status !== "waiting" && status !== "running";
        remove.addEventListener("click", (event) => {
          event.stopPropagation();
          if ("status" in item) {
            vscode.postMessage({ type: "multitask-cancel", id: item.id });
          } else {
            const index = queue.findIndex((candidate) => candidate.id === item.id);
            if (index >= 0) queue.splice(index, 1);
            renderQueue();
            renderMultitaskActivity();
          }
        });
        row.appendChild(iconWrap);
        row.appendChild(text);
        row.appendChild(statusEl);
        row.appendChild(steer);
        row.appendChild(remove);
        body.appendChild(row);
      });
      queueCard.appendChild(body);
      renderMultitaskActivity();
    }
    document.addEventListener("click", () => closeQueueMenu());
    composerPlusBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (plusMenuOpen) closePlusMenu();
      else openPlusMenu();
    });
    for (const item of composerPlusMenu.querySelectorAll(".plus-menu-item")) {
      item.addEventListener("click", (event) => {
        event.stopPropagation();
        const pick = item.dataset.pick;
        if (pick === "multitask") {
          if (multitaskMode) disableMultitask();
          else enableMultitask();
        } else if (pick && pick in MODE_ICONS) {
          setMode(pick);
        }
        closePlusMenu();
      });
    }
    document.addEventListener("click", () => closePlusMenu());
    updateComposerPlaceholder();
    updateComposerChrome();
    renderPlusMenu();
    function send() {
      const text = inputEl.value.trim();
      if (!text) {
        if (isBusy && queue.length > 0) sendQueuedNow();
        return;
      }
      inputEl.value = "";
      if (multitaskMode) {
        hideWelcome();
        vscode.postMessage({ type: "multitask-enqueue", text, mode: currentMode });
        return;
      }
      dispatch(text, currentMode);
    }
    sendBtn.addEventListener("click", send);
    inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        send();
      }
    });
    stopBtn.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
    undoBtn.addEventListener("click", () => {
      if (pendingUndoSha) vscode.postMessage({ type: "restore", sha: pendingUndoSha });
    });
    newBtn.addEventListener("click", () => vscode.postMessage({ type: "new" }));
    connectBtn.addEventListener("click", () => vscode.postMessage({ type: "connect" }));
    settingsBtn.addEventListener("click", () => vscode.postMessage({ type: "settings" }));
    const historyBtn = document.getElementById("history-btn");
    const historyView = document.getElementById("history-view");
    const histBack = document.getElementById("hist-back");
    const histSearch = document.getElementById("hist-search");
    const histScope = document.getElementById("hist-scope");
    const histSort = document.getElementById("hist-sort");
    const histList = document.getElementById("hist-list");
    let histChats = [];
    function openHistory() {
      document.body.classList.add("history-open");
      historyView.hidden = false;
      vscode.postMessage({ type: "history" });
    }
    function closeHistory() {
      document.body.classList.remove("history-open");
      historyView.hidden = true;
    }
    function relTime(ts) {
      const mins = Math.max(0, Math.round((Date.now() - ts) / 6e4));
      if (mins < 1) return "just now";
      if (mins < 60) return mins + "m ago";
      const hours = Math.round(mins / 60);
      if (hours < 24) return hours + "h ago";
      const days = Math.round(hours / 24);
      return days === 1 ? "yesterday" : days + "d ago";
    }
    function fuzzyScore(query, text) {
      const q = query.toLowerCase().trim();
      const t = text.toLowerCase();
      if (!q) return 1;
      if (t.includes(q)) return 2 + q.length / t.length;
      let qi = 0;
      for (let i = 0; i < t.length && qi < q.length; i++) {
        if (t[i] === q[qi]) qi++;
      }
      return qi === q.length ? 1 : 0;
    }
    function renderHistory() {
      histList.innerHTML = "";
      const query = histSearch.value;
      let rows = histChats.filter((c) => histScope.value === "current" ? c.current : true);
      const scored = rows.map((chat) => ({ chat, score: fuzzyScore(query, chat.title) })).filter((r) => r.score > 0);
      if (query.trim()) {
        scored.sort((a, b) => b.score - a.score || b.chat.updatedAt - a.chat.updatedAt);
      } else {
        scored.sort(
          (a, b) => histSort.value === "oldest" ? a.chat.updatedAt - b.chat.updatedAt : b.chat.updatedAt - a.chat.updatedAt
        );
      }
      if (scored.length === 0) {
        const empty = document.createElement("div");
        empty.className = "hist-empty";
        empty.textContent = histChats.length === 0 ? "No chats yet." : "No chats match.";
        histList.appendChild(empty);
        return;
      }
      for (const { chat } of scored) {
        const row = document.createElement("div");
        row.className = "hist-row";
        const main = document.createElement("div");
        main.className = "hist-row-main";
        const title = document.createElement("div");
        title.className = "hist-title";
        title.textContent = chat.title;
        const meta = document.createElement("div");
        meta.className = "hist-meta";
        const ws = chat.workspace.split("/").pop() || chat.workspace;
        meta.textContent = relTime(chat.updatedAt) + (histScope.value === "all" ? " \xB7 " + ws : "");
        main.appendChild(title);
        main.appendChild(meta);
        const del = document.createElement("button");
        del.className = "hist-delete";
        del.title = "Delete chat";
        del.textContent = "\u2715";
        del.addEventListener("click", (event) => {
          event.stopPropagation();
          vscode.postMessage({ type: "delete-chat", id: chat.id });
        });
        row.appendChild(main);
        row.appendChild(del);
        row.addEventListener("click", () => vscode.postMessage({ type: "open-chat", id: chat.id }));
        histList.appendChild(row);
      }
    }
    historyBtn.addEventListener("click", openHistory);
    histBack.addEventListener("click", closeHistory);
    histSearch.addEventListener("input", renderHistory);
    histScope.addEventListener("change", renderHistory);
    histSort.addEventListener("change", renderHistory);
    function resetChatUI() {
      for (const child of Array.from(messagesEl.children)) {
        if (child.id !== "welcome") child.remove();
      }
      ctxUsed = 0;
      ctxLimit = 0;
      if (ctxFlashTimer) {
        clearTimeout(ctxFlashTimer);
        ctxFlashTimer = null;
      }
      ctxGauge.hidden = true;
      toolCards.clear();
      reviewCards.clear();
      resetTurnSession();
      setComposerUndo(null);
      queue.length = 0;
      multitaskTasks = [];
      multitaskRunRows.clear();
      finishedSubagentsEl = null;
      queueStartingId = null;
      multitaskMode = false;
      queueCollapsed = false;
      renderMultitaskChip();
      renderQueue();
      renderMultitaskActivity();
      updateComposerPlaceholder();
      updateComposerChrome();
      closePlusMenu();
      clearHybridGroups();
      hideSpinner();
      backgroundWorkEl = null;
    }
    window.addEventListener("message", (event) => {
      const msg = event.data;
      switch (msg.type) {
        case "state": {
          backendChip.hidden = !msg.model;
          backendChip.textContent = msg.model;
          backendChip.title = msg.backend;
          const hasModels = Array.isArray(msg.hybridModels) && msg.hybridModels.length > 0;
          activeHybridLabel = typeof msg.hybridActiveLabel === "string" && msg.hybridActiveLabel.trim() ? msg.hybridActiveLabel.trim() : "Hybrid";
          if (hybridChip) {
            hybridChip.hidden = !hasModels && !msg.hybridEnabled;
            hybridChip.classList.toggle("muted", !msg.hybridEnabled);
          }
          if (hybridModelLabel) {
            hybridModelLabel.textContent = msg.hybridActiveLabel && msg.hybridActiveLabel !== "Hybrid" ? " \xB7 " + msg.hybridActiveLabel : "";
          }
          renderHybridMenu(msg.hybridModels ?? [], !!msg.hybridEnabled);
          isBusy = msg.busy;
          workElsewhere = Number(msg.workElsewhere ?? 0);
          sendBtn.disabled = false;
          updateComposerChrome();
          renderQueue();
          renderMultitaskActivity();
          renderBackgroundWork();
          if (!msg.busy) {
            hideSpinner();
            setTimeout(drainQueue, 0);
          } else if (!turnSession) {
            hideWelcome();
            showSpinner();
          }
          break;
        }
        case "multitask-list": {
          multitaskTasks = Array.isArray(msg.tasks) ? msg.tasks : [];
          if (multitaskTasks.some((task) => task.status === "waiting" || task.status === "running") && !multitaskMode) {
            enableMultitask();
          }
          syncMultitaskRunRows();
          renderQueue();
          renderMultitaskActivity();
          break;
        }
        case "tool-call": {
          hideSpinner();
          const row = trackToolCall(msg);
          toolCards.set(msg.id, row);
          if (msg.linesAdded || msg.linesDeleted) {
            row.dataset.added = String(msg.linesAdded ?? 0);
            row.dataset.deleted = String(msg.linesDeleted ?? 0);
          }
          showSpinner();
          scrollDown();
          break;
        }
        case "tool-result": {
          const row = toolCards.get(msg.id);
          if (!row) break;
          row.classList.remove("running");
          row.classList.add(msg.ok ? "ok" : "failed");
          const status = row.querySelector(".acc-status");
          if (status) status.textContent = msg.ok ? "\u2713" : "\u2717";
          if (msg.viaTrie && turnSession && typeof msg.trieMs === "number" && typeof msg.scanMs === "number") {
            turnSession.trieSavedMs += Math.max(0, msg.scanMs - msg.trieMs);
            refreshTurnSummary();
          }
          if (!msg.ok) {
            row.classList.add("failed");
            if (msg.summary) {
              const err = document.createElement("div");
              err.className = "acc-error";
              err.textContent = msg.summary;
              row.after(err);
            }
            const added = Number(row.dataset.added ?? 0);
            const deleted = Number(row.dataset.deleted ?? 0);
            if (turnSession && (added || deleted)) {
              turnSession.added = Math.max(0, turnSession.added - added);
              turnSession.deleted = Math.max(0, turnSession.deleted - deleted);
              refreshTurnSummary();
            }
          }
          break;
        }
        case "todos": {
          renderInlineTodos(msg.todo, msg.done);
          break;
        }
        case "context": {
          ctxUsed = msg.used;
          ctxLimit = msg.limit;
          if (!ctxFlashTimer) renderCtxGauge();
          break;
        }
        case "compaction": {
          if (msg.active) {
            if (ctxFlashTimer) {
              clearTimeout(ctxFlashTimer);
              ctxFlashTimer = null;
            }
            ctxGauge.hidden = false;
            ctxGauge.classList.add("compacting");
            ctxGauge.classList.remove("warn", "hot");
            ctxGauge.textContent = "Compacting\u2026";
            ctxGauge.title = "Summarizing older turns to free context";
          } else if (typeof msg.saved === "number" && msg.saved > 0) {
            ctxGauge.classList.remove("compacting");
            ctxGauge.textContent = "freed " + fmtTokens(msg.saved);
            ctxFlashTimer = setTimeout(() => {
              ctxFlashTimer = null;
              renderCtxGauge();
            }, 2500);
          } else {
            renderCtxGauge();
          }
          break;
        }
        case "hybrid-check": {
          if (msg.active) showHybridCheck(msg.checkpoint ?? "final_review");
          else settleHybridCheck(msg.checkpoint ?? "final_review");
          break;
        }
        case "hybrid-plan": {
          showHybridPlan(msg.subtasks, msg.rationale);
          break;
        }
        case "guide": {
          showHybridGuide(msg.checkpoint ?? "final_review", msg.verdict, msg.text);
          break;
        }
        case "final": {
          hideSpinner();
          finishTurnSession();
          addReply(msg.text, !msg.ok);
          if (msg.checkpoint) setComposerUndo(msg.checkpoint);
          if (msg.checkpoint) {
            const row = document.createElement("div");
            row.className = "checkpoint-row";
            const btn = document.createElement("button");
            btn.className = "ghost checkpoint-btn";
            btn.textContent = "\u21BA Restore checkpoint";
            btn.title = "Revert the workspace to how it was before this turn";
            btn.addEventListener("click", () => {
              vscode.postMessage({ type: "restore", sha: msg.checkpoint });
            });
            row.appendChild(btn);
            messagesEl.appendChild(row);
            scrollDown();
          }
          break;
        }
        case "review": {
          hideSpinner();
          setComposerUndo(msg.checkpoint, msg.files.length);
          renderReviewCard(msg.checkpoint, msg.files);
          break;
        }
        case "restored": {
          setComposerUndo(null);
          const card = reviewCards.get(msg.sha);
          if (card) {
            resolveReviewCard(card, "undone");
          } else {
            addReply(
              "Workspace restored to checkpoint " + msg.sha.slice(0, 8) + " (" + msg.files + " files reverted)."
            );
          }
          break;
        }
        case "error": {
          hideSpinner();
          finishTurnSession();
          addBubble("error", msg.text);
          isBusy = false;
          setTimeout(drainQueue, 0);
          break;
        }
        case "notice": {
          const el = document.createElement("div");
          el.className = "notice-row";
          el.textContent = msg.text;
          messagesEl.appendChild(el);
          scrollDown();
          break;
        }
        case "reset": {
          resetChatUI();
          showWelcome();
          break;
        }
        case "history": {
          histChats = msg.chats;
          renderHistory();
          break;
        }
        case "chat-loaded": {
          closeHistory();
          resetChatUI();
          hideWelcome();
          for (const entry of msg.transcript) {
            if (entry.role === "user") addBubble("user", entry.text);
            else if (entry.role === "error") addBubble("error", entry.text);
            else addReply(entry.text, entry.failed === true);
          }
          scrollDown();
          break;
        }
      }
    });
    vscode.postMessage({ type: "init" });
  })();
})();
/*! Bundled license information:

lucide/dist/esm/defaultAttributes.js:
lucide/dist/esm/createElement.js:
lucide/dist/esm/icons/arrow-right.js:
lucide/dist/esm/icons/bot.js:
lucide/dist/esm/icons/file-text.js:
lucide/dist/esm/icons/list-checks.js:
lucide/dist/esm/icons/message-circle-question.js:
lucide/dist/esm/lucide.js:
  (**
   * @license lucide v0.503.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)
*/
