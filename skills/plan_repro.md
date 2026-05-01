# Skill: Plan + Reproduce (NO implementation)

You are in PLAN MODE. Do NOT write, edit, or create any code files.
Your only job is to understand the issue, reproduce it, and write a plan.

---

## Phase 0 — Mini Grill Me (run this FIRST, before spawning any agents)

Read the issue below, then ask the 3–4 most important clarifying questions.
Do NOT explore the codebase, read files, or grep anything yet.

Ask only things **the user can answer** that cannot be inferred from code:
- Intended behavior / expected UX
- Which user roles or edge cases must be covered
- Scope constraints (e.g. must be backwards-compatible? enterprise-only?)
- Priority / urgency signals

For each question, include your recommended answer in [brackets].
Present all questions as a numbered list, then **stop and wait for the user to answer.**
Do not spawn any agents and do not investigate the codebase until after the user responds.

---

## How to run this skill (after Phase 0 answers received)

Spawn **Agent 1 and Agent 2 in parallel immediately.** Do not do any research yourself first.
Once both return, spawn **Agent 3** with their combined output.

```
Agent 1 — Code Investigation   (starts immediately)
Agent 2 — Reproduction         (starts immediately)
                                      ↓ both finish
Agent 3 — Plan Writeup         (starts only after 1 + 2 return)
```

---

## Agent 1 — Code Investigation

Prompt to pass verbatim (substitute the real issue text for `{{ISSUE}}`):

> You are investigating a bug. Do NOT write or edit any files.
>
> **Issue:** {{ISSUE}}
>
> Steps:
> 1. Grep and Read every file involved. Do not guess paths — verify with Glob first.
> 2. Quote the exact broken lines for each bug location.
> 3. Confirm root cause with evidence (schema fields, route lists, type definitions).
> 4. Enterprise endpoints live in `enterprise/litellm_enterprise/proxy/` — check there
>    when `/project/*`, `/team/*`, `/organization/*` routes aren't found in `litellm/proxy/`.
> 5. Always use paths relative to your working directory.
>
> Return a structured report:
> - File path + line number for each bug
> - Quoted broken code
> - One-sentence explanation per location

---

## Agent 2 — Reproduction + Screenshots

> **IMPORTANT: You are a browser + curl agent. Do NOT read code files or grep the codebase.
> Your only tools are: Bash (curl, node, and ImageMagick only), and Playwright MCP browser tools.
> If you need to know an API path, try it — don't read source code to find it.**

Prompt to pass verbatim (substitute real issue text and task_id):

> You are a browser and curl agent. Your ONLY allowed tools are Bash (for curl, node, and ImageMagick only) and Playwright MCP browser tools.
> You MUST NOT use Read, Grep, Glob, or any file-reading tools. If you catch yourself about to read a file, stop and use the browser instead.
> Do not investigate why the bug exists — just show that it exists via screenshots.
>
> **Issue:** {{ISSUE}}
> **Task ID:** {{TASK_ID}}
> **Screenshot dir:** /tmp/claude-screenshots/
>
> **SCREENSHOT NAMING — MANDATORY:**
> Every screenshot filename MUST start with `{{TASK_ID}}_`.
> For example: `/tmp/claude-screenshots/{{TASK_ID}}_admin_1.png`, `/tmp/claude-screenshots/{{TASK_ID}}_user_1_ann.png`.
> Names like `admin_home.png` or `screenshot.png` are WRONG — the plan cannot reference them and they will be excluded from the Gist.
> If you accidentally save to the wrong name, rename it immediately: `mv /tmp/claude-screenshots/wrong_name.png /tmp/claude-screenshots/{{TASK_ID}}_correct_name.png`
>
> ### Step 1 — Start the proxy (if not already running)
>
> ```bash
> curl -sf http://localhost:4000/health/readiness && echo "already up" || {
>   export LITELLM_MASTER_KEY=sk-1234
>   export UI_USERNAME=admin
>   export UI_PASSWORD=admin123
>   export DATABASE_URL=$LITELLM_SANDBOX_DB_URL
>   nohup uv run litellm --config proxy_server_config.yaml --port 4000 \
>     > /tmp/proxy.log 2>&1 &
>   for i in $(seq 1 30); do
>     curl -sf http://localhost:4000/health/readiness && break || sleep 2
>   done
> }
> ```
>
> If the proxy fails to start, show the last 30 lines of `/tmp/proxy.log` and
> continue with curl-only reproduction — skip Playwright steps.
>
> ### Step 2 — Set up test data via curl
>
> Use these known LiteLLM admin API paths to create test data:
> - Create team: `POST /team/new` `{"team_alias": "T1"}`
> - Create user: `POST /user/new` `{"user_role": "internal_user"}`
>   Response includes both `user_id` AND `key` — save both.
> - Add member: `POST /team/member_add` `{"team_id": "...", "member": {"user_id": "...", "role": "user"}}`
> - Create project: `POST /project/new` `{"project_name": "P1", "team_id": "..."}`
>   (If 404, try `POST /v1/project/new`)
>
> Save all IDs to shell variables. Show each response.
>
> ### Step 3 — Get session tokens
>
> **Admin token** — call the login endpoint:
> ```bash
> curl -s -X POST "http://localhost:4000/login" \
>   -H "Content-Type: application/x-www-form-urlencoded" \
>   --data-urlencode "username=admin" \
>   --data-urlencode "password=admin123" \
>   -c /tmp/admin_cookies.txt
> ADMIN_TOKEN=$(grep 'token' /tmp/admin_cookies.txt | awk '{print $NF}')
> ```
>
> **Internal user token** — mint a JWT directly (the /login endpoint is admin-only):
> ```bash
> USER_TOKEN=$(python3 -c "
> import jwt, json
> payload = {
>     'user_id': '$USER_ID',
>     'key': '$USER_KEY',
>     'user_email': None,
>     'user_role': 'internal_user',
>     'login_method': 'username_password',
>     'premium_user': False,
>     'auth_header_name': 'Authorization',
>     'disabled_non_admin_personal_key_creation': False,
>     'server_root_path': ''
> }
> print(jwt.encode(payload, 'sk-1234', algorithm='HS256'))
> " 2>/dev/null || python3 -c "
> import hmac, hashlib, base64, json
> secret = b'sk-1234'
> header = base64.urlsafe_b64encode(b'{\"alg\":\"HS256\",\"typ\":\"JWT\"}').rstrip(b'=').decode()
> payload_data = {'user_id':'$USER_ID','key':'$USER_KEY','user_role':'internal_user','login_method':'username_password','premium_user':False,'auth_header_name':'Authorization','disabled_non_admin_personal_key_creation':False,'server_root_path':''}
> payload = base64.urlsafe_b64encode(json.dumps(payload_data).encode()).rstrip(b'=').decode()
> sig = base64.urlsafe_b64encode(hmac.new(secret,f'{header}.{payload}'.encode(),hashlib.sha256).digest()).rstrip(b'=').decode()
> print(f'{header}.{payload}.{sig}')
> ")
> ```
>
> ### Step 4 — Admin journey (working state)
>
> **IMPORTANT browser rules:**
> - Always navigate to `http://localhost:4000/ui/` (root only). Never navigate to sub-routes
>   like `/ui/virtual-keys` — the static build crashes on sub-route direct navigation.
> - Inject session token via cookie before navigating, then navigate to root, then click sidebar.
> - ImageMagick font: always use `-font "/Library/Fonts/Arial Unicode.ttf"` (full path, macOS).
>   Use `magick` not `convert` (IMv7 deprecation).
>
> Use Playwright MCP tools:
> ```javascript
> // Inject admin token and navigate
> async (page) => {
>   await page.context().addCookies([{ name: 'token', value: ADMIN_TOKEN, domain: 'localhost', path: '/' }]);
>   await page.goto('http://localhost:4000/ui/');
>   await page.waitForTimeout(4000);
> }
> ```
> - Click "Virtual Keys" in sidebar (navigates to `?page=api-keys`)
> - Click "+ Create New Key" button
> - Click the Team dropdown, select the test team
> - After team selected: screenshot the Project dropdown state
> - `browser_take_screenshot` → `/tmp/claude-screenshots/{{TASK_ID}}_admin_N.png`
> - Annotate immediately with ImageMagick (green banner = working state):
>   ```bash
>   # Get image dimensions
>   W=$(magick identify -format "%w" /tmp/claude-screenshots/{{TASK_ID}}_admin_N.png)
>   H=$(magick identify -format "%h" /tmp/claude-screenshots/{{TASK_ID}}_admin_N.png)
>   BANNER=48
>   magick /tmp/claude-screenshots/{{TASK_ID}}_admin_N.png \
>     -fill none -stroke "#00cc44" -strokewidth 3 \
>     -draw "rectangle X1,Y1 X2,Y2" \
>     \( -size ${W}x${BANNER} xc:"#00cc44" \) -gravity South -composite \
>     -font "/Library/Fonts/Arial Unicode.ttf" \
>     -fill white -pointsize 20 -gravity South \
>     -annotate +0+12 "WORKING: What this shows" \
>     /tmp/claude-screenshots/{{TASK_ID}}_admin_N_ann.png
>   ```
>
> ### Step 5 — Internal user journey (broken state)
>
> Use Playwright MCP tools with the internal user token:
> ```javascript
> async (page) => {
>   // Open new context with user token
>   await page.context().addCookies([{ name: 'token', value: USER_TOKEN, domain: 'localhost', path: '/' }]);
>   await page.goto('http://localhost:4000/ui/');
>   await page.waitForTimeout(4000);
> }
> ```
> - Repeat the exact same flow (sidebar → Create Key → select team → Project dropdown)
> - Screenshot each step → `{{TASK_ID}}_user_N.png`
> - Annotate in red for broken state:
>   ```bash
>   W=$(magick identify -format "%w" /tmp/claude-screenshots/{{TASK_ID}}_user_N.png)
>   H=$(magick identify -format "%h" /tmp/claude-screenshots/{{TASK_ID}}_user_N.png)
>   BANNER=48
>   magick /tmp/claude-screenshots/{{TASK_ID}}_user_N.png \
>     -fill none -stroke red -strokewidth 3 \
>     -draw "rectangle X1,Y1 X2,Y2" \
>     \( -size ${W}x${BANNER} xc:"#cc0000" \) -gravity South -composite \
>     -font "/Library/Fonts/Arial Unicode.ttf" \
>     -fill white -pointsize 20 -gravity South \
>     -annotate +0+12 "BUG: What's wrong here" \
>     /tmp/claude-screenshots/{{TASK_ID}}_user_N_ann.png
>   ```
>
> ### Step 6 — API proof screenshot
>
> For EVERY curl call — whether the result is a failure, a success, or "not reproducing" —
> capture a terminal-style screenshot of the command + response.
> Text in the plan saying "returned HTTP 200" is NOT evidence. The screenshot is.
>
> ```bash
> # Run the curl and capture output
> API_RESULT=$(curl -s -w "\nHTTP %{http_code}" \
>   -H "Authorization: Bearer $USER_KEY" \
>   http://localhost:4000/project/list)
>
> # Format JSON if possible
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
>   caption:"$ curl -H 'Authorization: Bearer ...key...' http://localhost:4000/project/list
>
> $FORMATTED" \
>   /tmp/claude-screenshots/{{TASK_ID}}_api_proof_1.png
>
> # Add a colour-coded banner — green if expected result, red if failure
> W=$(magick identify -format "%w" /tmp/claude-screenshots/{{TASK_ID}}_api_proof_1.png)
> magick /tmp/claude-screenshots/{{TASK_ID}}_api_proof_1.png \
>   \( -size ${W}x48 xc:"#00cc44" \) -gravity South -composite \
>   -font "/Library/Fonts/Arial Unicode.ttf" -fill white -pointsize 20 -gravity South \
>   -annotate +0+12 "API: <what this proves>" \
>   /tmp/claude-screenshots/{{TASK_ID}}_api_proof_1_ann.png
> ```
>
> Repeat for each distinct API call (e.g. admin call, internal user call, non-member call).
> Name them `{{TASK_ID}}_api_proof_1_ann.png`, `_2_ann.png`, etc.
>
> ### Step 7 — (Optional) Video
>
> If the bug needs multiple interactions to be clear, record a trace:
> ```javascript
> // via browser_run_code:
> async (page) => {
>   await page.context().tracing.start({ screenshots: true, snapshots: true });
>   // navigate and interact
>   await page.context().tracing.stop({
>     path: '/tmp/claude-screenshots/{{TASK_ID}}_trace.zip'
>   });
> }
> ```
>
> Return:
> - Paths to all annotated screenshots in order: UI screenshots + API proof screenshots
> - One sentence per screenshot: what it shows and why it matters
> - Every claim in the plan must be backed by one of these screenshots — no unsubstantiated assertions

---

## Agent 3 — Plan Writeup

Prompt to pass verbatim (include Agent 1 and Agent 2 full output):

> You are writing a bug fix plan. You have been given code investigation findings
> and reproduction evidence below. Do NOT read any files — use only what is provided.
>
> **Code findings (from Agent 1):** {{AGENT_1_OUTPUT}}
>
> **Reproduction evidence (from Agent 2):** {{AGENT_2_OUTPUT}}
>
> Write the plan in five sections:
>
> ### Section 1 — Issue Understanding
> 3–5 sentences: what is broken, where, expected vs actual.
> Inline annotated screenshots where relevant: `![description](path_to_ann.png)`
>
> ### Section 2 — Root Cause
> Per bug: file path, line number, quoted code, one-sentence explanation.
> Number them if multiple.
>
> ### Section 3 — Reproduction
> - Inline annotated screenshots with captions:
>   "Admin sees X (working)" / "Internal user sees Y (broken because Z)"
> - Paste curl output proving the backend failure
>
> ### Section 4 — Proposed Fix
> Plain English only — no code. Per file:
> - File path + function/line
> - What to change and why
>
> ### Section 5 — Manual QA Validation
> Step-by-step instructions for a human to verify the fix works after implementation.
> Cover both UI and API paths. Be explicit — exact clicks, exact curl commands,
> exact expected responses. Example format:
>
> **UI validation:**
> 1. Sign in as proxy_admin → Teams → create team T1
> 2. Users → create internal_user U1 → add to T1
> 3. Sign out → sign in as U1
> 4. Virtual Keys → Create Key → select T1
> 5. ✅ Project dropdown shows P1 (previously showed "No data")
>
> **API validation:**
> ```bash
> curl -H "Authorization: Bearer $U1_KEY" http://localhost:4000/project/list
> # Expected: 200 {"data": [{"project_name": "P1", ...}]}
> # Previously: 401 "Only proxy admin..."
> ```
>
> Save the complete plan to `/tmp/claude-plans/{{SESSION_ID}}_plan.md`.
>
> Then create a **secret GitHub Gist** with the plan. Images are hosted on GitHub via the
> Contents API (Gist API doesn't support binary files):
>
> ```bash
> mkdir -p /tmp/claude-plans
>
> # Collect annotated screenshots — match both "{{TASK_ID}}_" and "task-{{TASK_ID}}_" prefixes,
> # then fall back to any _ann.png newer than the plan file
> SCREENSHOTS=$(ls /tmp/claude-screenshots/{{TASK_ID}}_*_ann.png \
>                  /tmp/claude-screenshots/task-{{TASK_ID}}_*_ann.png 2>/dev/null)
> if [ -z "$SCREENSHOTS" ]; then
>   SCREENSHOTS=$(find /tmp/claude-screenshots -name "*_ann.png" \
>     -newer /tmp/claude-plans/{{SESSION_ID}}_plan.md 2>/dev/null | sort)
> fi
> echo "Screenshots to upload: $(echo $SCREENSHOTS | wc -w)"
>
> # Upload each screenshot to GitHub via Contents API → get a raw.githubusercontent.com URL
> # (Gist API doesn't support binary files — this is the only way to get renderable image URLs)
> cp /tmp/claude-plans/{{SESSION_ID}}_plan.md /tmp/claude-plans/{{SESSION_ID}}_plan_gist.md
> for f in $SCREENSHOTS; do
>   FILENAME=$(basename "$f")
>   B64=$(base64 -i "$f" | tr -d '\n')
>   RAW_URL=$(gh api "repos/ishaan-berri/litellm/contents/qa-screenshots/{{TASK_ID}}/$FILENAME" \
>     --method PUT \
>     -f message="QA screenshots for task {{TASK_ID}}" \
>     -f content="$B64" \
>     --jq '.content.download_url' 2>/dev/null)
>   echo "Uploaded $FILENAME → $RAW_URL"
>   # Replace local path and bare filename with raw URL (use python to avoid sed -i macOS quirks)
>   python3 -c "
> import sys
> f = '/tmp/claude-plans/{{SESSION_ID}}_plan_gist.md'
> txt = open(f).read()
> txt = txt.replace('/tmp/claude-screenshots/$FILENAME', '$RAW_URL')
> txt = txt.replace('$FILENAME', '$RAW_URL')
> open(f, 'w').write(txt)
> "
> done
>
> # Create the secret gist (markdown only — images are already hosted on GitHub)
> GIST_URL=$(gh gist create \
>   /tmp/claude-plans/{{SESSION_ID}}_plan_gist.md \
>   --desc "Plan: {{TASK_ID}}" \
>   2>/dev/null | tail -1)
>
> echo "Gist: $GIST_URL"
> ```
>
> Output the Gist URL prominently at the end of your response.
>
> End with: **"Plan complete. Gist: {{GIST_URL}}. Awaiting approval to implement."**

---

## Rules

- Do NOT implement anything. No code files, no config changes.
- Agent 3 must not start until Agents 1 and 2 have both returned.
- Every screenshot must have an annotated version before being referenced in the plan.
- If Playwright is unavailable, note it and fall back to curl-only reproduction.
- If proxy fails to start, fall back to curl-only and show `/tmp/proxy.log` tail.

---

## Known working patterns (learned from QA runs)

### Browser session injection (replaces fallback/login)
The `/ui/fallback/login` route is unreliable (returns 404 on some builds).
Instead, inject tokens directly:
```javascript
// Admin: get token from /login endpoint first
// curl -X POST /login -d "username=admin&password=admin123" -c /tmp/cookies.txt
// Then in Playwright:
await page.context().addCookies([{ name: 'token', value: TOKEN, domain: 'localhost', path: '/' }]);
await page.goto('http://localhost:4000/ui/');  // root only — sub-routes crash static build
await page.waitForTimeout(4000);
// Then click sidebar links to navigate, e.g.: page.click('text=Virtual Keys')
```

### Internal user token (admin-only /login won't work for internal users)
Mint a JWT with the master key:
```python
import jwt
payload = {'user_id': USER_ID, 'key': USER_KEY, 'user_role': 'internal_user',
           'login_method': 'username_password', 'premium_user': False,
           'auth_header_name': 'Authorization',
           'disabled_non_admin_personal_key_creation': False, 'server_root_path': ''}
token = jwt.encode(payload, 'sk-1234', algorithm='HS256')
```

### ImageMagick on macOS — readable annotations
Font names like `Helvetica-Bold` don't work. Always add a solid color banner at the bottom — never paint text directly over the screenshot content (it becomes unreadable). Template:
```bash
W=$(magick identify -format "%w" input.png)
# Green banner for working state:
magick input.png \
  -fill none -stroke "#00cc44" -strokewidth 3 -draw "rectangle X1,Y1 X2,Y2" \
  \( -size ${W}x48 xc:"#00cc44" \) -gravity South -composite \
  -font "/Library/Fonts/Arial Unicode.ttf" -fill white -pointsize 20 -gravity South \
  -annotate +0+12 "WORKING: label text" \
  output_ann.png

# Red banner for broken state:
magick input.png \
  -fill none -stroke red -strokewidth 3 -draw "rectangle X1,Y1 X2,Y2" \
  \( -size ${W}x48 xc:"#cc0000" \) -gravity South -composite \
  -font "/Library/Fonts/Arial Unicode.ttf" -fill white -pointsize 20 -gravity South \
  -annotate +0+12 "BUG: label text" \
  output_ann.png
```

### Proxy startup env vars
Always set `UI_USERNAME=admin UI_PASSWORD=admin123` so the `/login` endpoint works:
```bash
export LITELLM_MASTER_KEY=sk-1234
export UI_USERNAME=admin
export UI_PASSWORD=admin123
export DATABASE_URL=$LITELLM_SANDBOX_DB_URL
```

### Static UI navigation
- `/ui/` root: loads fine ✅
- `/ui/virtual-keys`: crashes with "Application error" ❌
- After loading root, click sidebar text (e.g. `text=Virtual Keys`) — this uses `?page=api-keys` style routing which works ✅
