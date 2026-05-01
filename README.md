# shin-watcher

A long-running agent that periodically picks an open issue from `BerriAI/litellm`, clones the repo on the host, runs the proxy, attempts to reproduce the bug with screenshots, and writes a fix plan with a confidence verdict.

When `AUTO_FIX=true`, easy/medium issues also get a fix attempt: the agent applies the patch in the working tree, re-runs the exact repro flow against the patched proxy, captures BEFORE/AFTER screenshots and a GIF, pushes the branch to a bot fork, and opens a draft PR upstream.

Built on:
- **`@mariozechner/pi-agent-core`** — agent loop, tool execution, streaming
- **`@mariozechner/pi-ai`** — LLM layer pointed at your **LiteLLM proxy** (so every call is logged, cost-tracked, and dogfoods litellm)
- **`@modelcontextprotocol/sdk`** — bridges Microsoft's [Playwright MCP](https://github.com/microsoft/playwright-mcp) and the [GitHub MCP server](https://github.com/modelcontextprotocol/servers/tree/main/src/github) into pi-agent-core's `AgentTool` shape (pi-agent-core has no native MCP support, so we wrote a tiny bridge — see `src/mcp/bridge.ts`)
- **Skills from [`BerriAI/shin-builder`](https://github.com/BerriAI/shin-builder/tree/main/skills)** — `plan_repro.md` drives Phase 1, `implement.md` drives Phase 2

## How it works

```
every INTERVAL_MIN:
  1. picker        → next open issue not in cooldown
  2. proxy         → reset ./workdir/litellm to origin/main, start litellm on :4000
  3. ensure fork   → bot fork exists; `shin-bot` git remote configured with PAT
  4. agent runs:
       Phase 1 (always)
         - browser_snapshot/click/take_screenshot via Playwright MCP
         - shell + curl for proxy interaction
         - github_search_code, github_list_issue_comments via GitHub MCP for context
         - BEFORE_* screenshots → root-cause file:line → write_report (verdict + difficulty)
       Phase 2 (if AUTO_FIX=true AND verdict ≥ 3 AND difficulty ∈ {easy, medium})
         - shell to apply patch, restart proxy, re-run repro flow
         - AFTER_* screenshots → stitch_gif → demo.gif
         - git push shin-bot <branch>
         - github_create_pull_request (DRAFT, prefixed [shin-watcher][auto-repro])
         - github_add_issue_comment with verdict + before/after + PR link
  5. state         → record attempt, set cooldown
```

The agent owns Phase 2 end-to-end via MCP. The runner only sets up the conditions (proxy healthy, fork exists, remote configured) and enforces the daily PR cap via a `beforeToolCall` hook that blocks `github_create_pull_request` etc. when the cap is hit.

Sequential, one issue at a time. No cloud sandbox — everything runs on the host that runs the daemon.

## Verdict rubric (the agent must self-classify)

| Score | Meaning |
|---|---|
| **5** | Bug fully reproduced, root cause confirmed in code, fix plan validated end-to-end |
| **4** | Bug reproduced via curl/browser, root cause hypothesis with file:line evidence |
| **3** | Similar symptoms reproduced but not the exact reported flow |
| **2** | Partial signal — env starts, related behavior off, but reported flow didn't trigger |
| **1** | Setup failed (proxy didn't start, deps broken, missing data) |
| **0** | Unreproducible from the description (insufficient info, env-specific, feature request, question) |

## Difficulty rubric (gates Phase 2 auto-fix)

| Difficulty | Definition | Auto-fix? |
|---|---|---|
| **easy** | ≤1 file, ≤50 LOC, no schema/migration changes, no new deps | Yes |
| **medium** | ≤3 files, ≤200 LOC total, no DB migrations, no breaking API changes | Yes |
| **hard** | Anything else — migrations, breaking changes, large refactors, security-sensitive | **Plan only** |

Hard runtime cap: even if the agent self-classifies easy, if `git diff --stat` exceeds 200 LOC at PR time, the fix is aborted and the run falls back to plan-only.

## Setup

```bash
nvm use 20
npm install
cp .env.example .env
# edit .env — fill in LITELLM_BASE_URL, LITELLM_API_KEY, GITHUB_TOKEN, GITHUB_BOT_USERNAME
```

You also need:
- `gh` CLI authenticated as the bot account (used for fork creation)
- `git`, `uv` (for `uv run litellm`), and `ImageMagick` on the host
- Internet access for `npx -y @playwright/mcp@latest` and `npx -y @modelcontextprotocol/server-github` on first run (they self-install Playwright browsers and the GitHub MCP server)

Verify the MCP wiring:

```bash
npx tsx scripts/smoke-mcp.ts
# → spawning Playwright MCP …
#   ✔ 23 tools (browser_snapshot, browser_click, browser_take_screenshot, …)
# → spawning GitHub MCP …
#   ✔ N tools (github_create_pull_request, github_add_issue_comment, …)
```

## Running

```bash
# manual one-shot against a specific issue (recommended for first runs)
npm run once -- --issue 9876

# the cron daemon
npm run dev          # tsx watch
npm run build && npm start
```

## Safety flags

Both default to `false` so the first runs are local-only and you can eyeball the output before anything touches GitHub:

- `POST_COMMENTS=false` — when false, the daemon writes `./runs/<ts>__issue-<n>/report.md` and stops. No comment is posted.
- `AUTO_FIX=false` — when false, only Phase 1 (repro) runs. No fix is attempted, no PR is opened.

Flip them to `true` once you've reviewed ~10 dry-run reports and trust what the agent produces.

## Output

```
runs/
  2026-05-01T15-30-00Z__issue-9876/
    report.md           # verdict at top, screenshots, fix plan, success criteria
    screenshots/
      before_admin_1.png
      before_curl_500.png
      after_admin_1.png
      after_curl_200.png
      demo.gif          # only present if Phase 2 succeeded
    transcript.jsonl    # full pi-agent-core event stream
    meta.json           # { issue, score, difficulty, model, duration_ms, pr_url? }
```

## Why every LLM call goes through your LiteLLM proxy (and via the Anthropic API format)

We construct one `Model<'anthropic-messages'>` at startup pointed at `LITELLM_BASE_URL` and use it for every agent in every run. That means:

- All cost shows up in your LiteLLM spend dashboard
- All requests flow through your guardrails, key rotation, rate limiting
- Switching the underlying Claude variant is one line in your LiteLLM `model_list`
- It's a real continuous dogfood test of LiteLLM against agentic workloads

**Why Anthropic format (not OpenAI Completions):**

- Native Claude thinking blocks — `thinkingLevel: "high"` becomes a real `thinking.budget_tokens` parameter, not a hack
- Native prompt caching via `cache_control` breakpoints (skill prompts cache cleanly across tool turns)
- Cleaner tool-call semantics (no JSON-string args)
- All of the above survive LiteLLM's `/v1/messages` passthrough untouched when the underlying model is Claude

Note: `LITELLM_BASE_URL` should be the proxy ROOT with no `/v1` suffix — pi-ai's Anthropic SDK appends `/v1/messages` itself. Auth is `x-api-key`, which LiteLLM accepts as a virtual key.

## Skills

Skills live in `./skills/` and are loaded at agent startup into the system prompt:

- `plan_repro.md` — score 0-5, repro screenshots/GIFs, post GitHub comment, QA checklist
- `implement.md` — Phase 2 fix playbook (only loaded when `AUTO_FIX=true`)

To refresh `implement.md` from upstream:

```bash
gh api repos/BerriAI/shin-builder/contents/skills/implement.md --jq .content | base64 -d > skills/implement.md
```

## Limits

- One issue at a time. No parallel runs (intentional — keeps the host sane).
- Per-run wall clock cap: `MAX_RUN_MINUTES` (default 20).
- Daily auto-PR cap: `MAX_FIX_PRS_PER_DAY` (default 5).
- Cooldowns in `state.sqlite`: score≥4 → 7d, score≤1 → 30d, open auto-PR → infinite.
