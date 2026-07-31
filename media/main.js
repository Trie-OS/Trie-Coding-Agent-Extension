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

  // node_modules/lucide/dist/esm/icons/bot.js
  var Bot = [
    ["path", { d: "M12 8V4H8" }],
    ["rect", { width: "16", height: "12", x: "4", y: "8", rx: "2" }],
    ["path", { d: "M2 14h2" }],
    ["path", { d: "M20 14h2" }],
    ["path", { d: "M15 13v2" }],
    ["path", { d: "M9 13v2" }]
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
    const todosEl = document.getElementById("todos");
    const inputEl = document.getElementById("input");
    const sendBtn = document.getElementById("send-btn");
    const stopBtn = document.getElementById("stop-btn");
    const newBtn = document.getElementById("new-btn");
    const connectBtn = document.getElementById("connect-btn");
    const settingsBtn = document.getElementById("settings-btn");
    const backendChip = document.getElementById("backend-chip");
    const hybridChip = document.getElementById("hybrid-chip");
    const toolCards = /* @__PURE__ */ new Map();
    let spinnerEl = null;
    let planningEl = null;
    let hybridCheckEl = null;
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
    let turnSession = null;
    function turnSummaryText(session) {
      const elapsed = formatElapsed(Date.now() - session.startTime);
      const parts = [];
      if (session.editedPaths.size > 0) {
        const n = session.editedPaths.size;
        parts.push("Editing " + n + " file" + (n === 1 ? "" : "s"));
      }
      if (session.exploredFiles.size > 0) {
        const n = session.exploredFiles.size;
        parts.push("explored " + n + " file" + (n === 1 ? "" : "s"));
      } else if (session.exploredActions > 0) {
        parts.push("explored \xB7 " + session.exploredActions);
      }
      if (session.commandCount > 0) {
        parts.push("ran " + session.commandCount + " command" + (session.commandCount === 1 ? "" : "s"));
      }
      if (parts.length === 0) return "Worked for " + elapsed;
      return parts.join(", ");
    }
    function refreshTurnSummary() {
      if (!turnSession) return;
      turnSession.labelEl.textContent = turnSummaryText(turnSession);
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
      summary.innerHTML = '<span class="acc-chevron"></span><span class="turn-label">Working\u2026</span><span class="turn-stats" hidden><span class="stat-add"></span> <span class="stat-del"></span></span>';
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
      if (!thought.trim()) return;
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
      if (isExploreTool(msg.tool)) {
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
    function finishTurnSession() {
      if (!turnSession) return;
      refreshTurnSummary();
      const elapsed = formatElapsed(Date.now() - turnSession.startTime);
      if (turnSession.editedPaths.size === 0 && turnSession.exploredFiles.size === 0) {
        turnSession.labelEl.textContent = "Worked for " + elapsed;
      }
      turnSession = null;
      closeActiveGroup();
    }
    function resetTurnSession() {
      turnSession = null;
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
      return { text: (ext.slice(0, 2) || "\xB7").toUpperCase(), cls: "other" };
    }
    function resolveReviewCard(card, state) {
      card.classList.add("resolved", state);
      const actions = card.querySelector(".review-actions");
      if (actions) {
        actions.innerHTML = "";
        const note = document.createElement("span");
        note.className = "review-resolved-note";
        note.textContent = state === "kept" ? "\u2713 Changes kept" : "\u21BA Changes undone";
        actions.appendChild(note);
      }
    }
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
        const dir = parts.slice(0, -1).join("/");
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
        const dirEl = document.createElement("span");
        dirEl.className = "file-dir";
        dirEl.textContent = dir;
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
        row.appendChild(dirEl);
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
      const hint = document.createElement("span");
      hint.className = "review-hint";
      hint.textContent = "Click a file to review its diff";
      const undoBtn = document.createElement("button");
      undoBtn.className = "review-btn undo";
      undoBtn.textContent = "\u21BA Undo";
      undoBtn.title = "Revert the workspace to how it was before this turn";
      undoBtn.addEventListener("click", () => {
        vscode.postMessage({ type: "restore", sha });
      });
      const keepBtn = document.createElement("button");
      keepBtn.className = "review-btn keep";
      keepBtn.textContent = "\u2713 Keep";
      keepBtn.title = "Accept these changes";
      keepBtn.addEventListener("click", () => {
        resolveReviewCard(card, "kept");
      });
      actions.appendChild(hint);
      actions.appendChild(undoBtn);
      actions.appendChild(keepBtn);
      card.appendChild(actions);
      messagesEl.appendChild(card);
      scrollDown();
    }
    function activityHost() {
      return turnSession?.body ?? messagesEl;
    }
    function showHybridCheck(checkpoint) {
      hideHybridCheck();
      hideSpinner();
      hybridCheckEl = document.createElement("div");
      hybridCheckEl.className = "hybrid-check";
      const label = checkpoint === "stuck_hint" ? "Hybrid \xB7 checking stuck loop\u2026" : "Hybrid \xB7 reviewing local work\u2026";
      hybridCheckEl.innerHTML = '<span class="hybrid-check-pulse"></span><span class="hybrid-check-label"></span>';
      hybridCheckEl.querySelector(".hybrid-check-label").textContent = label;
      activityHost().appendChild(hybridCheckEl);
      scrollDown();
    }
    function hideHybridCheck() {
      hybridCheckEl?.remove();
      hybridCheckEl = null;
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
        currentMode = btn.dataset.mode || "code";
        for (const other of modeButtons) {
          const active = other === btn;
          other.classList.toggle("active", active);
          other.setAttribute("aria-pressed", String(active));
        }
        inputEl.placeholder = currentMode === "plan" ? "Describe what you want \u2014 the agent explores read-only and returns a plan\u2026" : currentMode === "ask" ? "Ask a question about this codebase (read-only)\u2026" : "Describe a task or ask a question\u2026";
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
    function showSpinner() {
      hideSpinner();
      showPlanning();
    }
    function hideSpinner() {
      hidePlanning();
      spinnerEl?.remove();
      spinnerEl = null;
    }
    function send() {
      const text = inputEl.value.trim();
      if (!text) return;
      hideWelcome();
      addBubble("user", text);
      inputEl.value = "";
      showSpinner();
      vscode.postMessage({ type: "send", text, mode: currentMode });
    }
    sendBtn.addEventListener("click", send);
    inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        send();
      }
    });
    stopBtn.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
    newBtn.addEventListener("click", () => vscode.postMessage({ type: "new" }));
    connectBtn.addEventListener("click", () => vscode.postMessage({ type: "connect" }));
    settingsBtn.addEventListener("click", () => vscode.postMessage({ type: "settings" }));
    window.addEventListener("message", (event) => {
      const msg = event.data;
      switch (msg.type) {
        case "state": {
          backendChip.hidden = !msg.model;
          backendChip.textContent = msg.model;
          backendChip.title = msg.backend;
          hybridChip.hidden = !msg.hybrid;
          sendBtn.disabled = msg.busy;
          stopBtn.hidden = !msg.busy;
          if (!msg.busy) hideSpinner();
          break;
        }
        case "tool-call": {
          hideSpinner();
          const row = trackToolCall(msg);
          toolCards.set(msg.id, row);
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
          if (msg.viaTrie) {
            row.classList.add("trie-fast");
            const badge = document.createElement("span");
            badge.className = "trie-badge";
            badge.title = "Answered instantly by the prefix-trie symbol index";
            badge.textContent = "\u26A1 trie";
            row.appendChild(badge);
          }
          if (!msg.ok) {
            row.classList.add("failed");
            if (msg.summary) {
              const err = document.createElement("div");
              err.className = "acc-error";
              err.textContent = msg.summary;
              row.after(err);
            }
          }
          break;
        }
        case "todos": {
          todosEl.hidden = msg.todo.length === 0 && msg.done.length === 0;
          todosEl.innerHTML = "";
          const title = document.createElement("div");
          title.className = "todos-title";
          title.textContent = "Todos";
          todosEl.appendChild(title);
          for (const item of msg.done) {
            const row = document.createElement("div");
            row.className = "todo done";
            row.textContent = "\u2611 " + item;
            todosEl.appendChild(row);
          }
          for (const item of msg.todo) {
            const row = document.createElement("div");
            row.className = "todo";
            row.textContent = "\u2610 " + item;
            todosEl.appendChild(row);
          }
          break;
        }
        case "hybrid-check": {
          if (msg.active) showHybridCheck(msg.checkpoint ?? "final_review");
          else hideHybridCheck();
          break;
        }
        case "guide": {
          hideHybridCheck();
          hideSpinner();
          const el = document.createElement("div");
          el.className = "guide " + (msg.verdict === "looks_good" ? "good" : "concern");
          const label = document.createElement("div");
          label.className = "guide-label";
          label.textContent = msg.checkpoint === "stuck_hint" ? "Hybrid \xB7 suggestion for local model" : "Hybrid \xB7 review of local work";
          const body = document.createElement("div");
          body.textContent = msg.text;
          el.appendChild(label);
          el.appendChild(body);
          activityHost().appendChild(el);
          scrollDown();
          break;
        }
        case "final": {
          hideHybridCheck();
          hideSpinner();
          finishTurnSession();
          addBubble(msg.ok ? "assistant" : "assistant failed", msg.text);
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
          renderReviewCard(msg.checkpoint, msg.files);
          break;
        }
        case "restored": {
          const card = reviewCards.get(msg.sha);
          if (card) {
            resolveReviewCard(card, "undone");
          } else {
            addBubble(
              "assistant",
              "Workspace restored to checkpoint " + msg.sha.slice(0, 8) + " (" + msg.files + " files reverted)."
            );
          }
          break;
        }
        case "error": {
          hideSpinner();
          addBubble("error", msg.text);
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
          for (const child of Array.from(messagesEl.children)) {
            if (child.id !== "welcome") child.remove();
          }
          todosEl.innerHTML = "";
          todosEl.hidden = true;
          toolCards.clear();
          reviewCards.clear();
          resetTurnSession();
          hideHybridCheck();
          hideSpinner();
          showWelcome();
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
lucide/dist/esm/icons/bot.js:
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
