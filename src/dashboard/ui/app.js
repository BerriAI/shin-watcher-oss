/* shin-watcher dashboard — vanilla JS, no build step */

// ── Utilities ────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const fmt = (ms) => {
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
};
const fmtTime = (iso) => {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
};
const verdictLabel = {
  0: "0 · None", 1: "1 · Failed", 2: "2 · Partial",
  3: "3 · Similar", 4: "4 · Repro", 5: "5 · Validated",
};
const diffLabel = { easy: "Easy", medium: "Medium", hard: "Hard" };

// ── Sessions sidebar (shared between index + session pages) ──────────────────

let allRuns = [];
let activeRuns = [];
let selectedTaskId = null;

async function loadSessions() {
  try {
    const data = await fetch("/api/runs").then((r) => r.json());
    allRuns = data.history || [];
    activeRuns = data.active || [];
    renderSidebar();
  } catch (e) {
    console.error("loadSessions", e);
  }
}

function renderSidebar() {
  const list = $("sessions-list");
  const countEl = $("session-count");
  if (!list) return;

  const total = allRuns.length + activeRuns.length;
  if (countEl) countEl.textContent = `${total} run${total !== 1 ? "s" : ""}`;

  let html = "";

  // Active runs first
  for (const run of activeRuns) {
    const isSelected = run.taskId === selectedTaskId;
    html += `
      <div class="session-item active-run${isSelected ? " selected" : ""}" data-taskid="${run.taskId}" onclick="openSession('${run.taskId}')">
        <div class="session-title"><span class="pulse-dot" style="margin-right:6px"></span>#${run.issueNumber} · ${esc(run.issueTitle)}</div>
        <div class="session-meta">
          <span class="verdict-chip v3">Running…</span>
          <span class="session-duration">${fmtTime(new Date(run.startedAt).toISOString())}</span>
        </div>
      </div>`;
  }

  // History
  for (const run of allRuns) {
    const taskIdForRun = guessTaskId(run);
    const isSelected = taskIdForRun === selectedTaskId;
    html += `
      <div class="session-item${isSelected ? " selected" : ""}" data-taskid="${taskIdForRun}" onclick="openSession('${taskIdForRun}')">
        <div class="session-title">#${run.issue_number} · <span style="color:var(--muted)">${fmtTime(run.attempted_at)}</span></div>
        <div class="session-meta">
          <span class="verdict-chip v${run.verdict}">${verdictLabel[run.verdict] || run.verdict}</span>
          <span class="diff-chip">${diffLabel[run.difficulty] || run.difficulty || ""}</span>
          <span class="session-duration">${fmt(run.duration_ms)}</span>
          ${run.pr_url ? `<a href="${run.pr_url}" target="_blank" style="font-size:10px;color:var(--green)" onclick="event.stopPropagation()">PR ↗</a>` : ""}
        </div>
      </div>`;
  }

  if (!html) html = `<div style="padding:20px 16px;color:var(--muted);font-size:12px">No runs yet. Try: run next</div>`;
  list.innerHTML = html;
}

// We store report_path which contains the full path; extract the taskId from it.
function guessTaskId(run) {
  if (!run.report_path) return `unknown-${run.id}`;
  // report_path = .../runs/<taskId>/report.md
  const parts = run.report_path.split("/");
  const idx = parts.indexOf("runs");
  return idx >= 0 && parts[idx + 1] ? parts[idx + 1] : `unknown-${run.id}`;
}

function openSession(taskId) {
  selectedTaskId = taskId;
  renderSidebar();
  const isSessionPage = window.location.pathname.startsWith("/session/");
  if (isSessionPage) {
    loadSessionContent(taskId);
    window.history.replaceState(null, "", `/session/${taskId}`);
  } else {
    window.location.href = `/session/${taskId}`;
  }
}
window.openSession = openSession;

// ── Invoke form (shared) ─────────────────────────────────────────────────────

function initInvokeForm() {
  const form = $("invoke-form");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("invoke-input");
    const btn = $("invoke-btn");
    const msg = $("invoke-msg");
    const command = input.value.trim();
    if (!command) return;

    btn.disabled = true;
    msg.textContent = "Starting…";
    msg.style.color = "var(--muted)";

    try {
      const res = await fetch("/api/invoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
      });
      const data = await res.json();
      if (data.error) {
        msg.textContent = data.message || data.error;
        msg.style.color = "var(--yellow)";
      } else if (data.started) {
        msg.textContent = `✓ Run queued${data.issueNumber ? ` for #${data.issueNumber}` : " (next eligible)"}. Waiting for agent…`;
        msg.style.color = "var(--green)";
        input.value = "";
        // Poll for the new active run and navigate to it
        pollForNewRun();
      } else {
        msg.textContent = data.message || "Unknown response";
        msg.style.color = "var(--yellow)";
      }
    } catch (err) {
      msg.textContent = "Error: " + err.message;
      msg.style.color = "var(--red)";
    } finally {
      btn.disabled = false;
    }
  });
}

async function pollForNewRun() {
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const data = await fetch("/api/active").then((r) => r.json()).catch(() => []);
    if (data.length > 0) {
      const run = data[0];
      activeRuns = data;
      renderSidebar();
      // navigate into the session
      window.location.href = `/session/${run.taskId}`;
      return;
    }
  }
  $("invoke-msg").textContent = "Run did not start in time — check terminal for errors.";
  $("invoke-msg").style.color = "var(--red)";
}

// ── Session page ─────────────────────────────────────────────────────────────

let sseConnection = null;

function initSessionPage() {
  const taskId = window.location.pathname.split("/session/")[1];
  if (!taskId) return;
  selectedTaskId = taskId;
  loadSessionContent(taskId);
  initSteerForm(taskId);
}

async function loadSessionContent(taskId) {
  // Is it a live run?
  const active = await fetch("/api/active").then((r) => r.json()).catch(() => []);
  const isLive = active.some((r) => r.taskId === taskId);
  const liveRun = active.find((r) => r.taskId === taskId);

  // Toolbar
  const issueLink = $("issue-link");
  const badges = $("toolbar-badges");
  if (isLive && liveRun) {
    issueLink.innerHTML = `<span class="pulse-dot" style="margin-right:8px"></span><a href="${liveRun.issueUrl}" target="_blank">#${liveRun.issueNumber} · ${esc(liveRun.issueTitle)}</a>`;
    badges.innerHTML = `<span class="verdict-chip v3">Live</span>`;
    enableSteer(taskId, true);
  } else {
    // Load from history
    const runs = await fetch("/api/runs").then((r) => r.json()).catch(() => ({ history: [] }));
    const run = runs.history?.find((r) => guessTaskId(r) === taskId);
    if (run) {
      issueLink.innerHTML = `#${run.issue_number} &nbsp;<span style="color:var(--muted);font-size:12px">${fmt(run.duration_ms)} · ${fmtTime(run.attempted_at)}</span>`;
      badges.innerHTML = `
        <span class="verdict-chip v${run.verdict}">${verdictLabel[run.verdict] || run.verdict}</span>
        <span class="diff-chip">${diffLabel[run.difficulty] || run.difficulty || ""}</span>
        ${run.pr_url ? `<a href="${run.pr_url}" target="_blank" class="verdict-chip" style="background:rgba(52,211,153,0.15);color:var(--green)">PR ↗</a>` : ""}
        ${run.error_message ? `<span class="verdict-chip v1" title="${esc(run.error_message)}">Error</span>` : ""}`;
    } else {
      issueLink.textContent = `Session ${taskId}`;
    }
    enableSteer(taskId, false);
    // Load the report
    loadReport(taskId);
  }

  // Load transcript (replay for finished, SSE for live)
  if (isLive) {
    connectSSE(taskId);
  } else {
    await replayTranscript(taskId);
    loadReport(taskId);
  }
}

// ── Transcript rendering ─────────────────────────────────────────────────────

const feed = () => $("transcript-feed");

function appendEvent(event) {
  const f = feed();
  if (!f) return;
  const t = event.ts ? new Date(event.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
  const rows = eventToRows(event);
  for (const row of rows) {
    const el = document.createElement("div");
    el.className = `feed-event ${row.cls}`;
    el.innerHTML = `<span class="feed-ts">${t}</span><span class="feed-body">${row.html}</span>`;
    f.appendChild(el);
  }
  f.scrollTop = f.scrollHeight;
}

function eventToRows(ev) {
  const type = ev.type;
  if (type === "message_update") {
    const ae = ev.assistantMessageEvent;
    if (!ae) return [];
    if (ae.type === "thinking_delta") return [{ cls: "ev-think", html: esc(ae.delta) }];
    if (ae.type === "text_delta") return [{ cls: "ev-text", html: esc(ae.delta) }];
    return [];
  }
  if (type === "tool_execution_start") {
    if (ev.toolName === "__steer__") {
      return [{ cls: "ev-steer", html: `<span class="ev-label">you →</span>${esc(ev.args?.message || "")}` }];
    }
    const argsStr = truncate(JSON.stringify(ev.args || {}), 200);
    return [{ cls: "ev-tool-call", html: `<span class="ev-label">→ ${esc(ev.toolName)}</span>${esc(argsStr)}` }];
  }
  if (type === "tool_execution_end") {
    const resultStr = truncate(JSON.stringify(ev.result || ""), 300);
    const cls = ev.isError ? "ev-tool-error" : "ev-tool-result";
    return [{ cls, html: `<span class="ev-label">← ${esc(ev.toolName)}</span>${esc(resultStr)}` }];
  }
  if (type === "agent_start") return [{ cls: "ev-system", html: "▶ agent started" }];
  if (type === "agent_end") return [{ cls: "ev-system", html: "■ agent finished" }];
  if (type === "run_end") return [{ cls: "ev-system", html: "■ run complete" }];
  if (type === "turn_start") return [];
  if (type === "turn_end") return [];
  if (type === "message_start") return [];
  if (type === "message_end") return [];
  return [];
}

async function replayTranscript(taskId) {
  const f = feed();
  if (!f) return;
  f.innerHTML = "";
  try {
    const events = await fetch(`/api/runs/${taskId}/transcript`).then((r) => r.json());
    for (let i = 0; i < events.length; i++) {
      appendEvent(events[i]);
      if (i % 5 === 0) await sleep(12); // gentle stagger for animation effect
    }
  } catch (e) {
    f.innerHTML = `<div class="feed-event ev-system"><span class="feed-ts"></span><span class="feed-body">Transcript not available</span></div>`;
  }
}

function connectSSE(taskId) {
  if (sseConnection) sseConnection.close();
  const f = feed();
  if (!f) return;
  f.innerHTML = "";
  appendEvent({ type: "agent_start", ts: Date.now() });

  const es = new EventSource(`/live/${taskId}`);
  sseConnection = es;

  es.onmessage = (e) => {
    const event = JSON.parse(e.data);
    if (event.type === "run_end") {
      appendEvent({ type: "run_end", ts: Date.now() });
      es.close();
      enableSteer(taskId, false);
      // Reload page state to show finished badges + report
      setTimeout(() => loadSessionContent(taskId), 1500);
      return;
    }
    appendEvent(event);
  };

  es.onerror = () => {
    appendEvent({ type: "agent_end", ts: Date.now() });
  };
}

// ── Report panel ─────────────────────────────────────────────────────────────

async function loadReport(taskId) {
  const el = $("report-content");
  const strip = $("screenshot-strip");
  if (!el) return;
  try {
    const md = await fetch(`/api/runs/${taskId}/report`).then((r) => {
      if (!r.ok) throw new Error("not found");
      return r.text();
    });
    el.className = "report-content";
    el.innerHTML = (typeof marked !== "undefined" ? marked.parse(md) : `<pre>${esc(md)}</pre>`);

    // Find screenshots from the markdown
    const matches = [...md.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)];
    if (strip && matches.length > 0) {
      strip.style.display = "flex";
      strip.innerHTML = matches.map(([, caption, src]) => {
        const url = src.startsWith("/") ? src : `/runs/${taskId}/screenshots/${src.split("/").pop()}`;
        return `<div><img src="${url}" alt="${esc(caption)}" onclick="openLightbox('${url}')" /><div class="caption">${esc(caption)}</div></div>`;
      }).join("");
    }
  } catch {
    el.className = "report-placeholder";
    el.textContent = "Report not available yet.";
  }
}

// ── Steer form ───────────────────────────────────────────────────────────────

function initSteerForm(taskId) {
  const form = $("steer-form");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("steer-input");
    const btn = $("steer-btn");
    const message = input.value.trim();
    if (!message) return;
    btn.disabled = true;
    input.value = "";
    try {
      const res = await fetch(`/api/runs/${taskId}/steer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (res.status === 410) {
        enableSteer(taskId, false);
        const label = $("steer-label-text");
        if (label) label.textContent = "Session ended — cannot steer";
      }
    } catch (err) {
      console.error("steer error", err);
    } finally {
      btn.disabled = false;
      input.focus();
    }
  });

  // Auto-resize textarea
  const input = $("steer-input");
  if (input) {
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 100) + "px";
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        form.dispatchEvent(new Event("submit"));
      }
    });
  }
}

function enableSteer(taskId, enabled) {
  const input = $("steer-input");
  const btn = $("steer-btn");
  const dot = $("steer-dot");
  const label = $("steer-label-text");
  if (input) input.disabled = !enabled;
  if (btn) btn.disabled = !enabled;
  if (dot) dot.style.display = enabled ? "inline-block" : "none";
  if (label) label.textContent = enabled ? "Steer the agent (Enter to send)" : "Session ended";
}

// ── Lightbox ─────────────────────────────────────────────────────────────────

function openLightbox(src) {
  const lb = $("lightbox");
  const img = $("lightbox-img");
  if (lb && img) { img.src = src; lb.classList.add("open"); }
}
window.openLightbox = openLightbox;

const closeLightbox = () => $("lightbox")?.classList.remove("open");
window.closeLightbox = closeLightbox;

document.addEventListener("DOMContentLoaded", () => {
  $("lightbox-close")?.addEventListener("click", closeLightbox);
  $("lightbox")?.addEventListener("click", (e) => { if (e.target === $("lightbox")) closeLightbox(); });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(str, n) {
  return str.length > n ? str.slice(0, n) + "…" : str;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Boot ─────────────────────────────────────────────────────────────────────

(async () => {
  await loadSessions();
  // Refresh sessions every 5s
  setInterval(loadSessions, 5000);

  initInvokeForm();

  // Session page specific init
  if (window.location.pathname.startsWith("/session/")) {
    initSessionPage();
  }
})();
