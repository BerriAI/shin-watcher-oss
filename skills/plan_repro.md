# Skill: Reproduce + Comment

## Goal
Reproduce the reported bug, score how real it is, and post evidence on the issue.
Then hand off clear instructions for fixing.

---

## Agent Role

**You are a browser + curl agent.** Do NOT read code files or grep the codebase. Your only tools are: Bash (curl, node, and ImageMagick only), and Playwright MCP browser tools. If you need to know an API path, try it — don't read source code to find it.

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

If the proxy fails to start, show the last 30 lines of `/tmp/proxy.log` and continue with curl-only reproduction — skip Playwright steps.

---

## Step 2 — Set up test data via curl

Use these known LiteLLM admin API paths to create test data:

- Create team: `POST /team/new {"team_alias": "T1"}`
- Create user: `POST /user/new {"user_role": "internal_user"}` — response includes both `user_id` AND `key`, save both.
- Add member: `POST /team/member_add {"team_id": "...", "member": {"user_id": "...", "role": "user"}}`
- Create project: `POST /project/new {"project_name": "P1", "team_id": "..."}` (if 404, try `POST /v1/project/new`)

Save all IDs to shell variables. Show each response.

---

## Step 3 — Get session tokens

**Admin token:**
```bash
curl -s -X POST "http://localhost:4000/login" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "username=admin" \
  --data-urlencode "password=admin123" \
  -c /tmp/admin_cookies.txt
ADMIN_TOKEN=$(grep 'token' /tmp/admin_cookies.txt | awk '{print $NF}')
```

**Internal user token** — mint a JWT directly (the `/login` endpoint is admin-only):
```bash
USER_TOKEN=$(python3 -c "
import jwt, json
payload = {
    'user_id': '$USER_ID',
    'key': '$USER_KEY',
    'user_email': None,
    'user_role': 'internal_user',
    'login_method': 'username_password',
    'premium_user': False,
    'auth_header_name': 'Authorization',
    'disabled_non_admin_personal_key_creation': False,
    'server_root_path': ''
}
print(jwt.encode(payload, 'sk-1234', algorithm='HS256'))
" 2>/dev/null || python3 -c "
import hmac, hashlib, base64, json
secret = b'sk-1234'
header = base64.urlsafe_b64encode(b'{\"alg\":\"HS256\",\"typ\":\"JWT\"}').rstrip(b'=').decode()
payload_data = {'user_id':'$USER_ID','key':'$USER_KEY','user_role':'internal_user','login_method':'username_password','premium_user':False,'auth_header_name':'Authorization','disabled_non_admin_personal_key_creation':False,'server_root_path':''}
payload = base64.urlsafe_b64encode(json.dumps(payload_data).encode()).rstrip(b'=').decode()
sig = base64.urlsafe_b64encode(hmac.new(secret,f'{header}.{payload}'.encode(),hashlib.sha256).digest()).rstrip(b'=').decode()
print(f'{header}.{payload}.{sig}')
")
```

---

## Step 4 — Admin journey (working state)

**Browser rules:**
- Always navigate to `http://localhost:4000/ui/` (root only). Never navigate to sub-routes like `/ui/virtual-keys` — the static build crashes on sub-route direct navigation.
- Inject session token via cookie before navigating, then navigate to root, then click sidebar.
- ImageMagick font: always use `-font "/Library/Fonts/Arial Unicode.ttf"` (full path, macOS). Use `magick` not `convert` (IMv7 deprecation).

Inject admin token and navigate:
```js
await page.context().addCookies([{ name: 'token', value: ADMIN_TOKEN, domain: 'localhost', path: '/' }]);
await page.goto('http://localhost:4000/ui/');
await page.waitForTimeout(4000);
```

1. Click "Virtual Keys" in sidebar (navigates to `?page=api-keys`)
2. Click "+ Create New Key" button
3. Click the Team dropdown, select the test team
4. Screenshot the Project dropdown state

**Screenshot naming — MANDATORY:** Every filename MUST start with `{{TASK_ID}}_`. Example: `{{TASK_ID}}_admin_1.png`. Names like `admin_home.png` are WRONG and will be excluded. If you save to the wrong name, rename immediately: `mv wrong_name.png {{TASK_ID}}_correct_name.png`

**Annotate with ImageMagick (green = working state):**
```bash
W=$(magick identify -format "%w" /tmp/claude-screenshots/{{TASK_ID}}_admin_N.png)
H=$(magick identify -format "%h" /tmp/claude-screenshots/{{TASK_ID}}_admin_N.png)
BANNER=48
magick /tmp/claude-screenshots/{{TASK_ID}}_admin_N.png \
  -fill none -stroke "#00cc44" -strokewidth 3 \
  -draw "rectangle X1,Y1 X2,Y2" \
  \( -size ${W}x${BANNER} xc:"#00cc44" \) -gravity South -composite \
  -font "/Library/Fonts/Arial Unicode.ttf" \
  -fill white -pointsize 20 -gravity South \
  -annotate +0+12 "WORKING: What this shows" \
  /tmp/claude-screenshots/{{TASK_ID}}_admin_N_ann.png
```

---

## Step 5 — Internal user journey (broken state)

Repeat the exact same flow with the internal user token:
```js
await page.context().addCookies([{ name: 'token', value: USER_TOKEN, domain: 'localhost', path: '/' }]);
await page.goto('http://localhost:4000/ui/');
await page.waitForTimeout(4000);
```

Screenshot each step → `{{TASK_ID}}_user_N.png`

**Annotate in red (broken state):**
```bash
W=$(magick identify -format "%w" /tmp/claude-screenshots/{{TASK_ID}}_user_N.png)
BANNER=48
magick /tmp/claude-screenshots/{{TASK_ID}}_user_N.png \
  -fill none -stroke red -strokewidth 3 \
  -draw "rectangle X1,Y1 X2,Y2" \
  \( -size ${W}x${BANNER} xc:"#cc0000" \) -gravity South -composite \
  -font "/Library/Fonts/Arial Unicode.ttf" \
  -fill white -pointsize 20 -gravity South \
  -annotate +0+12 "BUG: What's wrong here" \
  /tmp/claude-screenshots/{{TASK_ID}}_user_N_ann.png
```

---

## Step 6 — API proof screenshot

For EVERY curl call — whether failure, success, or "not reproducing" — capture a terminal-style screenshot. Text saying "returned HTTP 200" is NOT evidence. The screenshot is.

```bash
API_RESULT=$(curl -s -w "\nHTTP %{http_code}" \
  -H "Authorization: Bearer $USER_KEY" \
  http://localhost:4000/project/list)

FORMATTED=$(echo "$API_RESULT" | python3 -c "
import sys, json
lines = sys.stdin.read().rsplit('\n', 1)
try:
    body = json.dumps(json.loads(lines[0]), indent=2)
except:
    body = lines[0]
print(body + ('\n' + lines[1] if len(lines) > 1 else ''))
" 2>/dev/null || echo "$API_RESULT")

magick -background "#0d1117" -fill "#e6edf3" \
  -font "/Library/Fonts/Courier New.ttf" -pointsize 13 \
  -size 900x \
  caption:"$ curl -H 'Authorization: Bearer ...key...' http://localhost:4000/project/list

$FORMATTED" \
  /tmp/claude-screenshots/{{TASK_ID}}_api_proof_1.png

W=$(magick identify -format "%w" /tmp/claude-screenshots/{{TASK_ID}}_api_proof_1.png)
magick /tmp/claude-screenshots/{{TASK_ID}}_api_proof_1.png \
  \( -size ${W}x48 xc:"#00cc44" \) -gravity South -composite \
  -font "/Library/Fonts/Arial Unicode.ttf" -fill white -pointsize 20 -gravity South \
  -annotate +0+12 "API: <what this proves>" \
  /tmp/claude-screenshots/{{TASK_ID}}_api_proof_1_ann.png
```

Repeat for each distinct API call. Name them `{{TASK_ID}}_api_proof_1_ann.png`, `_2_ann.png`, etc.

---

## Step 7 — (Optional) Video trace

If the bug requires multiple interactions to be clear:
```js
await page.context().tracing.start({ screenshots: true, snapshots: true });
// navigate and interact
await page.context().tracing.stop({
  path: '/tmp/claude-screenshots/{{TASK_ID}}_trace.zip'
});
```

---

## Step 8 — Score (0–5)

| Score | Meaning |
|---|---|
| **5** | Reproduced exactly as reported, root cause confirmed |
| **4** | Reproduced, root cause is a strong hypothesis with file:line evidence |
| **3** | Similar symptoms reproduced, not the exact reported flow |
| **2** | Partial — env started, related behaviour off, reported flow didn't fire |
| **1** | Setup failed — couldn't even attempt (proxy down, deps broken) |
| **0** | Not reproducible — insufficient info, works as designed, or feature request |

---

## Step 9 — Comment on the issue

Post ONE comment via `github_add_issue_comment`:

```
## 🤖 shin-watcher repro report

**Score: N/5** — <one-line reason>

### Reproduction evidence
![caption](screenshot_url)
![caption](screenshot_url)

### What's broken
<2–3 sentences: exact symptom, affected endpoint/UI, expected vs actual>

### Root cause (if score ≥ 3)
- `path/to/file.py:LINE` — <quoted broken code> — <one sentence why>

---

### 👇 Fix instructions

**Difficulty:** easy | medium | hard

**What to change:**
1. <File + function + what to do>

**QA checklist:**
- [ ] <curl command or UI step> → expected result
- [ ] Existing tests still pass: `pytest <path>`
```

---

## Rules

- Every claim needs a screenshot. No unsubstantiated assertions.
- Score 0 or 1 → post the comment explaining why, then stop. Do not attempt a fix.
- Score ≥ 3 → include root cause and fix instructions.
- Keep comment under 40 lines. Use `<details>` to collapse verbose curl output.
- Return: paths to all annotated screenshots in order + one sentence per screenshot explaining what it shows and why it matters.
