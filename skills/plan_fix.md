# Skill: Fix + PR

## Goal
Investigate the reported issue, implement a concrete fix when possible, and open a draft PR with evidence.
Always produce a terminal report. Score is metadata, not a gate.

---

## Agent Role

**You are a browser + curl + code-change agent.** Use Bash, Playwright MCP browser tools, and GitHub tools to investigate and ship a draft PR when a code change is identifiable.

---

## Step 1 — Start the proxy (if not already running)

```bash
curl -sf http://localhost:4000/health/readiness && echo "already up" || {
  export LITELLM_MASTER_KEY=sk-1234
  export UI_USERNAME=admin
  export UI_PASSWORD=admin123
  export DATABASE_URL=$LITELLM_SANDBOX_DB_URL
  nohup uv run litellm --config proxy_server_config.yaml --port 4000 \
    > /tmp/proxy.log 2>&1 &
  for i in $(seq 1 30); do
    curl -sf http://localhost:4000/health/readiness && break || sleep 2
  done
}
```

If the proxy fails to start, show the last 30 lines of `/tmp/proxy.log` and continue with curl-only investigation.

---

## Step 2 — Investigate and capture BEFORE evidence

- Reproduce the reported behavior via API and/or UI.
- Capture screenshots for every material claim.
- Include at least one `before` screenshot showing the current behavior.
- Keep all artifact names prefixed with `{{TASK_ID}}_`.

---

## Step 3 — Implement the fix

- Identify exact file:line locations to change.
- Apply the smallest correct patch.
- Keep changes narrowly scoped to the reported issue.

---

## Step 4 — Validate and capture AFTER evidence

- Re-run the exact repro path after the patch.
- Capture matching `after` screenshots.
- Create a GIF if helpful to show before/after flow.

---

## Step 5 — Open a draft PR (default path)

When a code change is identifiable:

1. Create branch and commit.
2. Push to the bot fork.
3. Open a **draft** PR.
4. Include evidence links and checklist in the PR body.

PR body should include:

```
## 🤖 shin-watcher

# Confidence score: N/5

> **Why?**
> <2-4 sentences with concrete evidence>

---

### Reproduction evidence
![caption](screenshot_url)

### Root cause
- `path/to/file.py:LINE` — <what was wrong>

### Fix summary
1. <what changed>

### QA checklist
- [x] <step> -> <expected>
```

---

## Step 6 — Label issue (GitHub issue inputs only)

Only when the input is a real GitHub issue URL/number:

- Apply one label based on verdict:
  - 4-5: `shin-watcher: reproduced`
  - 2-3: `shin-watcher: partial`
  - 0-1: `shin-watcher: not-reproduced`

Do not invent issue labels for pasted/free-form non-issue inputs.

---

## Step 7 — Score (0-5, metadata only)

| Score | Meaning |
|---|---|
| **5** | Reproduced exactly, fix validated end-to-end |
| **4** | Reproduced with strong root cause and validated fix |
| **3** | Similar symptoms reproduced and a plausible fix shipped |
| **2** | Partial reproduction; fix attempted with limited confidence |
| **1** | Setup/investigation failed to reach reliable validation |
| **0** | Not reproducible / works as designed / no actionable change |

Score does **not** decide whether to open a PR. Actionability does.

---

## Step 8 — Unactionable bail-out (only exception to PR)

If and only if no actionable code change is identifiable:

- Do not open a PR.
- Call `write_report` with `no_action_reason` explaining why.
- Include evidence proving why this is unactionable (question-only request, works-as-designed, missing required scope, etc.).

---

## Rules

- A missing GitHub issue URL is **not** a reason to skip PR creation.
- "Feature request" wording is **not** a reason to skip PR creation when a concrete code change exists.
- Every claim needs screenshot or command evidence.
- Always call `write_report` exactly once.
