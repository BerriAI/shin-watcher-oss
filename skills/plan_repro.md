# Skill: Reproduce + Comment

## Goal
Reproduce the reported bug, score how real it is, and post evidence on the issue.
Then hand off clear instructions for fixing.

---

## Step 1 — Reproduce

Use the browser (Playwright MCP) and curl to trigger the exact behaviour the reporter described.

- Navigate the admin UI: inject the session token via cookie → navigate to `http://localhost:4000/ui/` → click sidebar links (never navigate directly to sub-routes).
- Take **annotated screenshots** at every key state:
  - Green banner (`#00cc44`) = working / expected state
  - Red banner (`#cc0000`) = broken / actual state
- For each curl call: capture the command + response as a terminal-style screenshot. Text claims are not evidence — screenshots are.
- If the bug involves multiple steps, stitch screenshots into a GIF with `stitch_gif` (BEFORE → steps → AFTER).

---

## Step 2 — Score (0–5)

Pick one score and write 1–2 sentences explaining why.

| Score | Meaning |
|---|---|
| **5** | Reproduced exactly as reported, root cause confirmed in code |
| **4** | Reproduced, root cause is a strong hypothesis with file:line evidence |
| **3** | Similar symptoms reproduced, not the exact reported flow |
| **2** | Partial — env started, related behaviour off, reported flow didn't fire |
| **1** | Setup failed — couldn't even attempt (proxy down, deps broken) |
| **0** | Not reproducible — insufficient info, works as designed, or it's a feature request |

---

## Step 3 — Comment on the issue

Post ONE comment via `github_add_issue_comment` with this structure:

```
## 🤖 shin-watcher repro report

**Score: N/5** — <one-line reason>

### Reproduction evidence
![caption](screenshot_url)
![caption](screenshot_url)
<!-- or: ![demo](gif_url) -->

### What's broken
<2–3 sentences: exact symptom, affected endpoint/UI element, expected vs actual>

### Root cause (if score ≥ 3)
- `path/to/file.py:LINE` — <quoted broken code> — <one sentence why>

---

### 👇 Fix instructions for the next agent

**Difficulty:** easy | medium | hard

**What to change:**
1. <File + function + what to do>
2. ...

**QA checklist (manual validation after fix):**
- [ ] <curl command or UI step> → expected result
- [ ] <curl command or UI step> → expected result
- [ ] Existing tests still pass: `pytest <path>`
```

---

## Rules

- Every claim needs a screenshot. No unsubstantiated assertions.
- Score 0 or 1 → post the comment explaining why, then stop. Do not attempt a fix.
- Score ≥ 3 → include root cause and fix instructions in the comment.
- Keep the comment under 40 lines. Use `<details>` to collapse verbose curl output.
