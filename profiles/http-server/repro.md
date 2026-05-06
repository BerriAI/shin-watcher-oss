# Skill: Reproduce + Comment (http-server profile)

## Goal
Reproduce the reported bug on http-party/http-server, score how real it is, and post evidence on the issue.

---

## Agent Role

**You are a curl + shell agent.** Your tools: shell (for starting/stopping the server with the issue's flag combination), curl (for HTTP probes against the running server), and Playwright MCP browser tools (for any UI-facing case). You may read code with `cat` / `grep` to confirm the root cause once the bug is reproduced.

---

## Step 1 — Read the issue carefully

The reported bugs in this repo usually fall into one of:
- **Crash on a specific flag combination** (e.g. `-d false -i` triggering a readonly property assign)
- **Wrong response for a particular path or query** (e.g. directory listing edge cases)
- **Misbehaviour around CORS, range requests, or proxy mode**

Identify which category. Note the exact command line and request the user reported.

---

## Step 2 — Start the server with the reported flags

The server has already been started for you on `<proxyPort>` with the default flags from this profile (`-d false -i`). Verify it's responding:

```bash
curl -sf http://localhost:<proxyPort>/ -o /dev/null -w "HTTP %{http_code}\n"
```

If the reported bug requires a *different* flag combination than the profile's default, kill the running server and restart with the user's exact flags. You can find the running PID with `lsof -i :<proxyPort>` or by looking at the proxy.log path returned by begin_repro_run.

```bash
node ./bin/http-server -p <proxyPort> <user's flags from the issue> > /tmp/http-server-repro.log 2>&1 &
```

---

## Step 3 — Reproduce the bug

Issue exactly the same HTTP request the user describes. Capture status, headers, body, and any stderr from the server log.

```bash
curl -i http://localhost:<proxyPort><path> 2>&1 | tee /tmp/repro-response.txt
```

Take an "API proof" terminal-style screenshot using ImageMagick (same pattern as the litellm profile) into `screenshotDir`:

```bash
magick -background "#0d1117" -fill "#e6edf3" \
  -font "/Library/Fonts/Courier New.ttf" -pointsize 13 \
  -size 900x \
  caption:"$(cat /tmp/repro-response.txt)" \
  <screenshotDir>/{{TASK_ID}}_repro.png
```

---

## Step 4 — Confirm root cause (optional, but boosts score from 4 to 5)

If the bug throws a stack trace, find the file:line in the cloned source:

```bash
grep -rn "<unique error string>" lib/ bin/
```

Quote the broken code in the report.

---

## Step 5 — Score (0–5)

Same scale as the litellm profile:

| Score | Meaning |
|---|---|
| **5** | Reproduced exactly as reported, root cause confirmed with file:line |
| **4** | Reproduced, root cause is a strong hypothesis with file:line evidence |
| **3** | Similar symptoms reproduced, not the exact reported flow |
| **2** | Partial — server started, related behaviour off, exact flow didn't fire |
| **1** | Setup failed — couldn't even attempt (server crashed on boot, deps broken) |
| **0** | Not reproducible — insufficient info, works as designed, or feature request |

---

## Step 6 — Comment on the issue

Use the same comment structure as the litellm profile (`## 🤖 shin-watcher` heading, score, evidence, root cause if score ≥ 3, fix instructions if score ≥ 3).

---

## Step 7 — Apply a shin-watcher label

Same label mapping as the litellm profile:

| Verdict | Label |
|---------|-------|
| 4–5     | `shin-watcher: reproduced` |
| 2–3     | `shin-watcher: partial` |
| 0–1     | `shin-watcher: not-reproduced` |

---

## Rules

- Every claim needs a screenshot.
- Score 0 or 1 → STILL post the comment. Explain clearly why you couldn't repro.
- Keep the comment under 50 lines. Use `<details>` to collapse verbose curl output.
