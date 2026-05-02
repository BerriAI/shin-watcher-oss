# shin-watcher agent audit — issue #27030 repro run
_Date: 2026-05-02_

---

## What worked ✅

- **Comment was posted** and is well-written: 5-variation table, clear verdict (0/5), root-cause hypothesis, actionable maintainer guidance
- **Verdict was technically correct** — the proxy at :4000 does return 404, so "not reproducible" is right
- **Streaming worked** — text deltas flowed to the chat immediately, no lag
- **GitHub write access** (github_add_issue_comment) worked once AUTO_FIX=true in .env
- **Structured analysis** — the agent correctly read the issue, ran variations, and reasoned about the JSON `code` field vs. HTTP status confusion

---

## Critical bugs ❌

### 1. Agent skipped `begin_repro_run` entirely
The agent never called `begin_repro_run`. It went straight from its first text message to curl tool calls. This means:
- No LiveBus `run_start` event (the repro panel never opened in the UI)
- No isolated clone directory was created
- No proxy port was allocated for testing
- The `write_report` call at the end couldn't resolve a `task_id`

**Root cause:** The system prompt says "call begin_repro_run first" but `plan_repro.md Step 1` says "check if proxy is already running on :4000" — the agent saw a server at :4000 and short-circuited the entire setup flow.

**Fix needed:** Make `begin_repro_run` the mandatory first tool call with NO escape hatch. Add to system prompt: "Your first tool call MUST be begin_repro_run. Do not call any other tool before it."

### 2. Agent tested the wrong proxy (:4000 = shin-watcher's own LLM router)
The existing LiteLLM proxy at `:4000` is the one shin-watcher uses for its own LLM calls (`LITELLM_BASE_URL`). The agent hit that and declared "proxy is up", then ran curl tests against it. It never spawned a fresh litellm clone.

**Root cause:** Port 4000 is both `config.proxy.port` (default test port) AND the LiteLLM proxy used for AI calls. The `plan_repro.md` Step 1 pattern "check localhost:4000" is misleading.

**Fix needed:**
- Change `portCounter` start in `beginReproRun.ts` from `config.proxy.port` (4000) to something guaranteed not in use (e.g. 5000+)
- Add to system prompt: "NEVER test against the proxy already running for your LLM calls. You must always clone and spin up a fresh isolated instance."

### 3. Two duplicate LiveBus runs registered (both stuck in "setup")
`/api/status` showed two active tasks for issue #27030, both in "setup" phase, never progressing. These were orphaned because `begin_repro_run` was called after the HTTP chat response had already completed (not as the detach trigger).

**Fix needed:**
- Add a TTL/cleanup in LiveBus: auto-remove runs stuck in "setup" phase for > 10 minutes
- The `begin_repro_run` detach logic in `server.ts` needs to handle the case where the tool is called mid-run rather than at the start

### 4. `write_report` called without `task_id` → report written to wrong path
Because `begin_repro_run` was never called, there was no `task_id`. The `write_report` tool fell back to `opts.reportPath` (the placeholder path `runs/_placeholder/report.md`), so the report was not saved to a real run directory.

**Fix needed:** Make `task_id` required in `write_report` when called from a root session. If `task_id` is missing, reject the call and force the agent to call `begin_repro_run` first.

---

## Quality improvements 🔧

### 5. First message isn't "issue analysis first, tools second"
The agent's first message simultaneously described the plan AND reported tool results ("Proxy is up. Now let me reproduce the bug"). The constraint "no tools in first response" was obeyed technically, but the agent started tool calls in its very next message without first calling `begin_repro_run`.

**Fix:** "After your first plain-text analysis, your next action must be `begin_repro_run`. Do not make any other tool calls until that has returned."

### 6. No isolated environment = no reproducibility guarantee
The agent tested against a proxy that may have custom config, running models, users, etc. For accurate repro the agent needs a vanilla fresh litellm clone with only `proxy_server_config.yaml` defaults.

**Fix:** System prompt must be stronger: "You MUST always clone a fresh litellm repo and start a new proxy. Never reuse existing services even if a server is already listening."

### 7. Screenshots saved to wrong dir (or /tmp)
The agent tried to save screenshots without a `screenshotDir` from `begin_repro_run`. They likely went to `/tmp` or the default Playwright output dir, not `runs/{taskId}/screenshots/`.

**Fix:** Part of enforcing `begin_repro_run` first — it returns the `screenshotDir` path.

### 8. LiveBus "setup" phase never transitions to "agent" phase
In the old runner, `LiveBus.startRun(taskId, issue, agent)` was called when the agent was ready, transitioning the run to "agent" phase. The new session design never calls `startRun`, so the phase stays "setup" forever.

**Fix:** In `session.ts`, when `begin_repro_run` is called, also call `LiveBus.startRun(taskId, issue, rootAgent)` to register the agent and flip the phase.

---

## Summary priority order

| # | Issue | Severity |
|---|-------|----------|
| 1 | begin_repro_run not called first | Critical |
| 2 | Agent tests wrong proxy (:4000) | Critical |
| 3 | LiveBus runs orphaned in setup | High |
| 4 | write_report saves to wrong path | High |
| 5 | Phase never transitions to "agent" | Medium |
| 6 | No fresh clone enforcement | Medium |
| 7 | Screenshots in wrong dir | Medium |
| 8 | First message structure | Low |
