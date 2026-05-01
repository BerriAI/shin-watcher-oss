# Skill: Implement + QA

The plan has been reviewed and approved. Implement it, then prove it works with annotated screenshots.

---

## Phase 1 — Implementation

1. Follow the plan exactly. If you discover an adjustment is needed, explain before deviating.
2. Edit only the files listed in the plan. Do not touch unrelated code.
3. After all edits: run `uv run black .` on every changed Python file.
4. Run the relevant unit tests:
   ```bash
   uv run pytest tests/proxy_unit_tests/ -k "project" -v --tb=short 2>&1 | tail -30
   ```
   If tests fail, fix them before proceeding to QA.

---

## Phase 2 — Manual QA (required — do not skip)

Prove the fix/feature works end-to-end using the real proxy + browser.
Spawn **QA Agent** immediately after Phase 1 completes.

**Every change type requires before + after annotated screenshots — no exceptions.**
- **API bug fix** → terminal screenshot of the error/wrong response (red banner, BEFORE) + terminal screenshot of the correct response (green banner, AFTER)
- **UI bug fix** → browser screenshot showing broken state (red banner, BEFORE) + browser screenshot showing fixed state (green banner, AFTER)
- **API feature** → terminal screenshot of the endpoint not existing or missing field (red banner, BEFORE) + terminal screenshot of the new response (green banner, AFTER)
- **UI feature** → browser screenshot of the UI before the feature (red banner, BEFORE) + browser screenshot of the feature working (green banner, AFTER)

Determine which applies from the plan context and instruct the QA Agent accordingly.

### QA Agent prompt (pass verbatim, substitute real values):

> You are a QA agent. Do NOT read code files or grep the codebase.
> Your only tools are Bash (curl, node, ImageMagick only) and Playwright MCP browser tools.
>
> **Task:** Prove the fix works. You MUST capture BOTH:
> 1. A **before screenshot** (red banner) showing the broken/missing/wrong state — captured BEFORE installing the fix
> 2. An **after screenshot** (green banner) showing the fix working — captured AFTER installing the fix
>
> This applies to ALL change types. For API changes: terminal-style screenshots. For UI changes: browser screenshots. Do not skip the before screenshot — a PR with only after screenshots will be rejected.
>
> **Screenshot dir:** /tmp/claude-screenshots/
> **Task ID:** {{TASK_ID}}
>
> ### Step 1 — Capture the BEFORE state (do this FIRST, before installing anything)
>
> Start the proxy with the **main repo** (unmodified) code and capture the broken state.
>
> ```bash
> VENV=/Users/ishaanjaffer/Library/Caches/pypoetry/virtualenvs/litellm-bPxhP-9D-py3.11
> MAIN_REPO=/Users/ishaanjaffer/github/litellm
> pkill -f "litellm.*4000" 2>/dev/null; lsof -ti :4000 | xargs kill -9 2>/dev/null || true; sleep 2
> $VENV/bin/pip install -e "$MAIN_REPO" --no-deps -q 2>&1 | tail -3
> export LITELLM_MASTER_KEY=sk-1234 UI_USERNAME=admin UI_PASSWORD=admin123 DATABASE_URL=$LITELLM_SANDBOX_DB_URL
> nohup $VENV/bin/litellm --config "$MAIN_REPO/proxy_server_config.yaml" --port 4000 > /tmp/proxy_before.log 2>&1 &
> for i in $(seq 1 30); do curl -sf http://localhost:4000/health/readiness && echo "proxy up" && break || sleep 2; done
> ```
>
> Run the API call / open the UI that demonstrates the bug. Capture a **red-banner screenshot**:
>
> ```bash
> # For API: capture error/wrong response
> RESULT=$(curl -s -w "\nHTTP %{http_code}" -H "Authorization: Bearer $USER_KEY" http://localhost:4000/<endpoint>)
> FORMATTED=$(echo "$RESULT" | python3 -c "import sys,json; lines=sys.stdin.read().rsplit('\n',1); body=json.dumps(json.loads(lines[0]),indent=2) if lines[0].strip().startswith('{') else lines[0]; print(body+('\n'+lines[1] if len(lines)>1 else ''))" 2>/dev/null || echo "$RESULT")
> magick -background "#0d1117" -fill "#e6edf3" -font "/Library/Fonts/Courier New.ttf" -pointsize 13 -size 900x \
>   caption:"$ curl ... http://localhost:4000/<endpoint>\n\n$FORMATTED" \
>   /tmp/claude-screenshots/{{TASK_ID}}_before_raw.png
> W=$(magick identify -format "%w" /tmp/claude-screenshots/{{TASK_ID}}_before_raw.png)
> magick /tmp/claude-screenshots/{{TASK_ID}}_before_raw.png \
>   \( -size ${W}x48 xc:"#cc0000" \) -gravity South -composite \
>   -font "/Library/Fonts/Arial Unicode.ttf" -fill white -pointsize 20 -gravity South \
>   -annotate +0+12 "BROKEN: <what is wrong>" \
>   /tmp/claude-screenshots/{{TASK_ID}}_before_ann.png
> echo "Before screenshot: /tmp/claude-screenshots/{{TASK_ID}}_before_ann.png"
> ```
>
> Verify the file exists and is non-empty before continuing. If you cannot capture the broken state, stop and report why.
>
> ### Step 2 — Kill the before-proxy
>
> ```bash
> pkill -f "litellm.*4000" 2>/dev/null; lsof -ti :4000 | xargs kill -9 2>/dev/null || true; sleep 2
> echo "proxy killed"
> ```
>
> ### Step 3 — Install the worktree into the venv
>
> The venv is the single Python environment the proxy binary uses.
> Installing the worktree makes the venv point at the worktree code.
>
> ```bash
> VENV=/Users/ishaanjaffer/Library/Caches/pypoetry/virtualenvs/litellm-bPxhP-9D-py3.11
> WORKTREE=$(git worktree list | grep "task-{{TASK_ID}}" | awk '{print $1}')
> WORKTREE=${WORKTREE:-$(pwd)}
> echo "Installing from: $WORKTREE"
> $VENV/bin/pip install -e "$WORKTREE" --no-deps -q 2>&1 | tail -5
> ```
>
> ### Step 4 — Verify the install points at the worktree
>
> **Do not skip this.** If this shows the wrong path, the proxy will run old code.
>
> ```bash
> $VENV/bin/python3 -c "import litellm; print('litellm path:', litellm.__file__)"
> # Must show: .../worktrees/task-{{TASK_ID}}/litellm/__init__.py
> # If it shows the main repo or site-packages: stop and report the path
> ```
>
> ### Step 5 — Start a fresh proxy with the fix
>
> ```bash
> export LITELLM_MASTER_KEY=sk-1234
> export UI_USERNAME=admin
> export UI_PASSWORD=admin123
> export DATABASE_URL=$LITELLM_SANDBOX_DB_URL
> nohup $VENV/bin/litellm --config "$WORKTREE/proxy_server_config.yaml" --port 4000 \
>   > /tmp/proxy_qa.log 2>&1 &
> echo "Waiting for proxy..."
> for i in $(seq 1 30); do
>   curl -sf http://localhost:4000/health/readiness && echo "proxy up" && break || sleep 2
> done
> ```
>
> If the proxy fails to start after 60s, show `tail -40 /tmp/proxy_qa.log` and stop.
>
> ### Step 6 — Restore the venv after QA (always run this, even if QA fails)
>
> ```bash
> MAIN_REPO=/Users/ishaanjaffer/github/litellm
> $VENV/bin/pip install -e "$MAIN_REPO" --no-deps -q 2>&1 | tail -3
> echo "venv restored to main repo"
> ```
>
> ### Step 7 — API validation with terminal screenshots (after screenshots)
>
> Follow the **API validation** steps from Section 5 of the plan exactly.
> For EVERY curl call, capture a terminal-style screenshot of the command + response.
> "The API returned 200" typed as text is NOT proof. The screenshot is.
>
> ```bash
> # Run curl and capture output
> API_RESULT=$(curl -s -w "\nHTTP %{http_code}" \
>   -H "Authorization: Bearer $USER_KEY" \
>   http://localhost:4000/<endpoint>)
>
> # Format JSON body
> FORMATTED=$(echo "$API_RESULT" | python3 -c "
> import sys, json
> lines = sys.stdin.read().rsplit('\n', 1)
> try:
>     body = json.dumps(json.loads(lines[0]), indent=2)
> except:
>     body = lines[0]
> print(body + ('\n' + lines[1] if len(lines) > 1 else ''))
> " 2>/dev/null || echo "$API_RESULT")
>
> # Render as terminal-style screenshot
> magick -background "#0d1117" -fill "#e6edf3" \
>   -font "/Library/Fonts/Courier New.ttf" -pointsize 13 \
>   -size 900x \
>   caption:"$ curl -H 'Authorization: Bearer ...key...' http://localhost:4000/<endpoint>
>
> $FORMATTED" \
>   /tmp/claude-screenshots/{{TASK_ID}}_qa_api_1.png
>
> # Green banner = fix confirmed; red banner = still broken
> W=$(magick identify -format "%w" /tmp/claude-screenshots/{{TASK_ID}}_qa_api_1.png)
> magick /tmp/claude-screenshots/{{TASK_ID}}_qa_api_1.png \
>   \( -size ${W}x48 xc:"#00cc44" \) -gravity South -composite \
>   -font "/Library/Fonts/Arial Unicode.ttf" -fill white -pointsize 20 -gravity South \
>   -annotate +0+12 "FIXED: <what this proves>" \
>   /tmp/claude-screenshots/{{TASK_ID}}_qa_api_1_ann.png
> ```
>
> Name them `{{TASK_ID}}_qa_api_1_ann.png`, `_2_ann.png`, etc.
> If any expected response doesn't match: say so and stop — do not proceed to browser steps.
>
> ### Step 8 — Browser QA (after screenshots)
>
> Follow the **UI validation** steps from Section 5 of the plan exactly.
>
> **Session injection pattern** (use this instead of /login for non-admin users):
> ```bash
> # Admin token — from /login endpoint:
> curl -s -X POST "http://localhost:4000/login" \
>   -H "Content-Type: application/x-www-form-urlencoded" \
>   --data-urlencode "username=admin" \
>   --data-urlencode "password=admin123" \
>   -c /tmp/qa_cookies.txt > /dev/null
> ADMIN_TOKEN=$(grep 'token' /tmp/qa_cookies.txt | awk '{print $NF}')
>
> # Internal user token — mint JWT directly:
> USER_TOKEN=$(python3 -c "
> import jwt
> payload = {'user_id': '$USER_ID', 'key': '$USER_KEY', 'user_role': 'internal_user',
>            'login_method': 'username_password', 'premium_user': False,
>            'auth_header_name': 'Authorization',
>            'disabled_non_admin_personal_key_creation': False, 'server_root_path': ''}
> print(jwt.encode(payload, 'sk-1234', algorithm='HS256'))
> ")
> ```
>
> **Browser rules:**
> - Always inject token as cookie before navigating: `ctx.addCookies([{name:'token', value:TOKEN, domain:'localhost', path:'/'}])`
> - Always navigate to root `http://localhost:4000/ui/` — never sub-routes
> - After loading root, click sidebar text links to navigate (e.g. `text=Virtual Keys`)
> - Wait 4s after navigation before interacting
>
> For each screenshot:
> - Take it with `browser_take_screenshot`
> - Annotate immediately with a color-coded banner at the bottom:
>
> **Bug fix — broken state** (red banner, take this FIRST if showing before/after):
> ```bash
> W=$(magick identify -format "%w" INPUT.png)
> magick INPUT.png \
>   \( -size ${W}x52 xc:"#cc0000" \) -gravity South -composite \
>   -font "/Library/Fonts/Arial Unicode.ttf" -fill white -pointsize 20 -gravity South \
>   -annotate +0+14 "BROKEN: <what is wrong>" \
>   OUTPUT_ann.png
> ```
>
> **Fixed state / feature working** (green banner):
> ```bash
> W=$(magick identify -format "%w" INPUT.png)
> magick INPUT.png \
>   \( -size ${W}x52 xc:"#00cc44" \) -gravity South -composite \
>   -font "/Library/Fonts/Arial Unicode.ttf" -fill white -pointsize 20 -gravity South \
>   -annotate +0+14 "FIXED: <what now works>" \
>   OUTPUT_ann.png
> ```
>
> Save all screenshots to `/tmp/claude-screenshots/{{TASK_ID}}_qa_N_ann.png`.
>
> ### Step 9 — Return
>
> Return:
> - Path to the **before screenshot** (red banner) and one sentence: what broken state it shows
> - Path to each **after screenshot** (green banner) and one sentence: what fixed state it shows
> - Confirmation that venv was restored (Step 6 output)
> - If anything failed: exact error output and which step it was
>
> **Do not return without both a before and after screenshot. If you could not capture the before state, say so explicitly — do not silently omit it.**

---

## Phase 3 — Summary + PR

After the QA Agent returns:

### 3a — QA gate (do not file PR if this fails)

QA passes only if ALL of the following are true:
- At least one **red-banner annotated screenshot** exists showing the broken/missing state (BEFORE)
- At least one **green-banner annotated screenshot** exists showing the fix working (AFTER)
- For API changes: both screenshots are terminal-style (curl command + response rendered with ImageMagick)
- For UI changes: both screenshots are browser screenshots with banners overlaid
- Unit tests passed (or no relevant tests exist — say so explicitly)

**Evidence rules — BEFORE + AFTER required for every change type, no exceptions:**
- **API bug fix** → BEFORE: terminal screenshot of the wrong response / error (red banner) + AFTER: terminal screenshot of the correct response (green banner)
- **UI bug fix** → BEFORE: browser screenshot of broken UI (red banner) + AFTER: browser screenshot of fixed UI (green banner)
- **API feature** → BEFORE: terminal screenshot showing feature missing / wrong (red banner) + AFTER: terminal screenshot of new response (green banner)
- **UI feature** → BEFORE: browser screenshot without the feature (red banner) + AFTER: browser screenshot with the feature working (green banner)

**STOP — do not file PR if:**
- No red-banner (before) screenshot exists in `/tmp/claude-screenshots/`
- No green-banner (after) screenshot exists in `/tmp/claude-screenshots/`
- Any screenshot is a local file path only — screenshots must be uploaded to GitHub and embedded as `![...](https://...)` URLs, not local paths

If QA failed: output a summary of what failed and stop. Do not file a PR.

### 3b — Capture evidence for the PR body

Before writing the PR, collect the proof artifacts:

**For UI changes — take a final annotated screenshot:**
```bash
# After QA confirms it works, take one clean "money shot" screenshot
# showing the exact UI element that was broken now working.
# Save to: /tmp/claude-screenshots/{{TASK_ID}}_qa_final_ann.png
```

**For UI changes — optionally record an MP4:**
```bash
# Use Playwright trace or ffmpeg screen capture if the flow requires multiple steps:
ffmpeg -y -f avfoundation -framerate 30 -i "1:none" \
  -t 30 -vcodec libx264 -pix_fmt yuv420p \
  /tmp/claude-screenshots/{{TASK_ID}}_qa_demo.mp4
# Or export Playwright trace as video:
# page.video() records automatically when browserType.launch({recordVideo: ...}) is used
```

**For API changes — save curl output to a file:**
```bash
curl -s -X GET "http://localhost:4000/project/list" \
  -H "Authorization: Bearer $USER_KEY" | tee /tmp/qa_api_proof.json
```

### 3c — File the PR (only if QA passed)

```bash
export GH_TOKEN="$SHIN_GITHUB_TOKEN"
WORKTREE=$(git worktree list | grep "task-{{TASK_ID}}" | awk '{print $1}')
cd "$WORKTREE"

# 1. Name the branch litellm_<slug> — CI only runs on litellm_* branches
BRANCH="litellm_$(git rev-parse --abbrev-ref HEAD | sed 's/^task-//')"
git checkout -b "$BRANCH" 2>/dev/null || git checkout "$BRANCH"

# 2. Stage only the files changed in Phase 1 (list them explicitly)
git add <file1> <file2> ...

# 3. Commit
git commit -m "<concise description of the fix>"

# 4. Ensure fork exists, then push branch to fork
gh repo fork BerriAI/litellm --clone=false 2>/dev/null || true
git remote add shin "https://oss-agent-shin:${SHIN_GITHUB_TOKEN}@github.com/oss-agent-shin/litellm.git" 2>/dev/null || \
  git remote set-url shin "https://oss-agent-shin:${SHIN_GITHUB_TOKEN}@github.com/oss-agent-shin/litellm.git"
git push shin "$BRANCH"

# 5. Collect all annotated screenshots and upload them to GitHub
# ALL screenshots must be uploaded — local paths are not accepted in the PR body.

# Gather before (red-banner) screenshots
BEFORE_SHOTS=$(ls /tmp/claude-screenshots/{{TASK_ID}}_*broken*_ann.png \
                  /tmp/claude-screenshots/{{TASK_ID}}_*_repro_*_ann.png \
                  /tmp/claude-screenshots/{{TASK_ID}}_*before*_ann.png \
                  /tmp/claude-screenshots/{{TASK_ID}}_qa_api_*_before*_ann.png 2>/dev/null | head -3)

# Gather after (green-banner) screenshots
AFTER_SHOTS=$(ls /tmp/claude-screenshots/{{TASK_ID}}_qa_*_ann.png \
                 /tmp/claude-screenshots/{{TASK_ID}}_*fixed*_ann.png \
                 /tmp/claude-screenshots/{{TASK_ID}}_*after*_ann.png 2>/dev/null | head -3)

# STOP if missing before or after evidence
if [ -z "$BEFORE_SHOTS" ]; then
  echo "ERROR: No before (broken-state) screenshot found. Do not file PR until QA captures it."
  exit 1
fi
if [ -z "$AFTER_SHOTS" ]; then
  echo "ERROR: No after (fixed-state) screenshot found. Do not file PR until QA captures it."
  exit 1
fi

# Upload screenshots to GitHub and get public URLs
upload_screenshot() {
  local f="$1"
  local name=$(basename "$f")
  local b64=$(base64 < "$f")
  local url=$(curl -s -X PUT \
    -H "Authorization: token $SHIN_GITHUB_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"message\":\"QA screenshot $name\",\"content\":\"$b64\"}" \
    "https://api.github.com/repos/ishaan-berri/litellm/contents/qa-screenshots/{{TASK_ID}}/$name" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['content']['download_url'])" 2>/dev/null)
  echo "$url"
}

before_md=""
for f in $BEFORE_SHOTS; do
  url=$(upload_screenshot "$f")
  [ -n "$url" ] && before_md+="![Before: broken state]($url)\n" || before_md+="*(upload failed for $(basename $f))*\n"
done

after_md=""
for f in $AFTER_SHOTS; do
  url=$(upload_screenshot "$f")
  [ -n "$url" ] && after_md+="![After: fix working]($url)\n" || after_md+="*(upload failed for $(basename $f))*\n"
done

# Verify at least one URL was produced for each section
if [[ "$before_md" != *"http"* ]]; then
  echo "ERROR: Before screenshot upload failed. Do not file PR without embedded evidence."
  exit 1
fi
if [[ "$after_md" != *"http"* ]]; then
  echo "ERROR: After screenshot upload failed. Do not file PR without embedded evidence."
  exit 1
fi

# 6. Open PR — body MUST contain inline uploaded screenshots, not local paths
# A PR without embedded GitHub-hosted screenshots will be rejected.
gh pr create \
  --repo BerriAI/litellm \
  --base litellm_internal_staging \
  --head "oss-agent-shin:$BRANCH" \
  --title "<title under 70 chars>" \
  --body "$(cat <<EOF
## What

<1-2 sentences describing the change>

## Why

<root cause in one sentence>

## Plan

<link to planning gist — copy from plan output, format: https://gist.github.com/...>

## Testing

<!-- REQUIRED: before + after screenshots embedded as GitHub-hosted URLs. Local paths, checkboxes, and text-only descriptions are not accepted. -->

### Before (broken state)
<!-- Red-banner screenshot showing the error / missing / wrong behavior -->
$(echo -e "$before_md")

### After (fixed state)
<!-- Green-banner screenshot showing the fix working -->
$(echo -e "$after_md")

EOF
)"

# 7. Verify the filed PR body actually contains embedded screenshots
PR_NUMBER=$(gh pr list --repo BerriAI/litellm --head "oss-agent-shin:$BRANCH" --json number -q '.[0].number')
PR_BODY=$(gh pr view "$PR_NUMBER" --repo BerriAI/litellm --json body -q .body)

BEFORE_IN_PR=$(echo "$PR_BODY" | grep -c "Before (broken" || true)
AFTER_IN_PR=$(echo "$PR_BODY" | grep -c "After (fixed" || true)
IMAGES_IN_PR=$(echo "$PR_BODY" | grep -cE '!\[.*\]\(https://' || true)

if [ "$IMAGES_IN_PR" -lt 2 ]; then
  echo "ERROR: PR body has fewer than 2 embedded images ($IMAGES_IN_PR found). Before + after screenshots required."
  echo "PR URL: https://github.com/BerriAI/litellm/pull/$PR_NUMBER"
  echo "Update the PR body with: gh pr edit $PR_NUMBER --repo BerriAI/litellm --body '...'"
  exit 1
fi

echo "PR screenshot check passed: $IMAGES_IN_PR images embedded in PR #$PR_NUMBER"
```

### 3d — Final output

1. **Files changed** — path + one-line description per file
2. **Test results** — paste the pytest tail
3. **QA evidence** — inline every annotated screenshot: `![caption](path)`, or MP4 path if recorded
4. **API proof** — paste the exact curl command and response
5. **PR link** — the URL returned by `gh pr create`

End with: **"Implementation complete."**

---

## Rules

- Do not skip Phase 2. Before + after annotated screenshots are required for every PR — no exceptions, no change types exempt.
- **A PR filed without both a red-banner (before) and green-banner (after) screenshot uploaded to GitHub and embedded in the PR body is INVALID. Do not file it.**
- Text output, code blocks, checkboxes ("✅ validated"), or links to external gists are NOT proof. The screenshots must be embedded directly in the PR body as `![...](https://raw.githubusercontent.com/...)` or `![...](https://github.com/.../raw/...)` URLs.
- For API-only changes the "before" screenshot is a terminal-style image of the wrong/missing response (red banner) and the "after" is the correct response (green banner) — same ImageMagick pattern as UI screenshots.
- If the proxy won't start, show the log tail and ask for help — do not fake the QA.
- Use `magick` not `convert`. Font always `/Library/Fonts/Arial Unicode.ttf`.
- Never navigate to sub-routes like `/ui/virtual-keys` — always load root `/ui/` then click sidebar.
