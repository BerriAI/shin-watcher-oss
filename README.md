# shin-watcher

A long-running agent that periodically picks an open issue from `BerriAI/litellm`, clones the repo on the host, runs the proxy, attempts to reproduce the bug with screenshots, and writes a fix plan with a confidence verdict.

When `AUTO_FIX=true`, easy/medium issues also get a fix attempt: the agent applies the patch in the working tree, re-runs the exact repro flow against the patched proxy, captures BEFORE/AFTER screenshots and a GIF, pushes the branch to a bot fork, and opens a draft PR upstream.

Built on:
- **`@mariozechner/pi-agent-core`** — agent loop, tool execution, streaming
- **`@mariozechner/pi-ai`** — LLM layer pointed at your **LiteLLM proxy** (so every call is logged, cost-tracked, and dogfoods litellm)
- **Skills from [`BerriAI/shin-builder`](https://github.com/BerriAI/shin-builder/tree/main/skills)** — `plan_repro.md` drives Phase 1, `implement.md` drives Phase 2

## How it works

```
every INTERVAL_MIN:
  1. picker        → next open issue not in cooldown
  2. proxy         → reset ./workdir/litellm to origin/main, start litellm on :4000
  3. agent (pi)    → load skills, run Phase 1 (repro) with shell+curl+browser tools
  4. report parse  → extract verdict (0–5) and difficulty (easy|medium|hard)
  5. (optional)    → Phase 2 (fix), only if verdict ≥ 3 AND difficulty ≠ hard
                     AND AUTO_FIX=true AND daily PR cap not hit
  6. github        → (optional) post comment on the issue, open draft fork-PR
  7. state         → record attempt, set cooldown
```

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
npx playwright install chromium
cp .env.example .env
# edit .env — fill in LITELLM_BASE_URL, LITELLM_API_KEY, GITHUB_TOKEN, GITHUB_BOT_USERNAME
```

You also need:
- `gh` CLI authenticated as the bot account (used for fork creation and PR opening)
- `git`, `uv` (for `uv run litellm`), and `ImageMagick` on the host

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

## Why every LLM call goes through your LiteLLM proxy

`pi-ai` ships a `provider: 'litellm'` Model type with `baseUrl` and `compat` flags pre-tuned for litellm quirks (e.g. `supportsStore: false`). We construct one `Model<'openai-completions'>` at startup pointed at `LITELLM_BASE_URL` and use it for every agent in every run. That means:

- All cost shows up in your litellm spend dashboard
- All requests go through your guardrails, key rotation, rate limiting
- Switching the underlying model is one config line in your litellm `model_list`
- It's a real continuous dogfood test of litellm against agentic workloads

## Skills

Skills are vendored from `BerriAI/shin-builder` into `./skills/`. They get loaded at agent startup and prepended to the system prompt:

- `plan_repro.md` — Phase 1 playbook (Phase 0 grill is auto-skipped)
- `implement.md` — Phase 2 playbook
- `grill_me.md` — kept for reference; the daemon never calls it (autonomous mode)

To refresh the skills, re-vendor from upstream:

```bash
gh api repos/BerriAI/shin-builder/contents/skills/plan_repro.md --jq .content | base64 -d > skills/plan_repro.md
gh api repos/BerriAI/shin-builder/contents/skills/implement.md  --jq .content | base64 -d > skills/implement.md
gh api repos/BerriAI/shin-builder/contents/skills/grill_me.md   --jq .content | base64 -d > skills/grill_me.md
```

## Limits

- One issue at a time. No parallel runs (intentional — keeps the host sane).
- Per-run wall clock cap: `MAX_RUN_MINUTES` (default 20).
- Daily auto-PR cap: `MAX_FIX_PRS_PER_DAY` (default 5).
- Cooldowns in `state.sqlite`: score≥4 → 7d, score≤1 → 30d, open auto-PR → infinite.
