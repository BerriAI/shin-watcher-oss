# shin-watcher

![shin-watcher](banner.png)

an agent that picks open LiteLLM GitHub issues, tries to reproduce them, and writes a report with a verdict score and before/after screenshots.

when `AUTO_FIX=true`, easy/medium issues also get a fix attempt and a draft PR.

## Features

- picks open issues automatically, no manual triage
- reproduces bugs via browser + curl against a live LiteLLM proxy
- scores each issue 0–5 and classifies difficulty
- posts a report comment with screenshots when `POST_COMMENTS=true`
- opens a draft fix PR when `AUTO_FIX=true`

<img width="1878" height="1685" alt="Xnapper-2026-05-01-19 45 52" src="https://github.com/user-attachments/assets/022bff8e-94ed-4adc-92ea-cfbec165f234" />


## Setup

```bash
nvm use 20
npm install
cp .env.example .env
# fill in LITELLM_BASE_URL, LITELLM_API_KEY, GITHUB_TOKEN, GITHUB_BOT_USERNAME
```

Prerequisites: `gh` CLI (authenticated), `git`, `uv`, `ImageMagick`.

## Usage

```bash
# one-shot against a specific issue
npm run once -- --issue 9876

# continuous daemon
npm run dev
```

## Safety flags

Both default to `false` — first runs are local-only so you can review output before anything touches GitHub.

- `POST_COMMENTS` — post the report as a GitHub issue comment
- `AUTO_FIX` — attempt a fix and open a draft PR

## Verdict scores

| Score | Meaning |
|---|---|
| 5 | Fully reproduced, root cause confirmed, fix validated |
| 4 | Reproduced, root cause with file:line evidence |
| 3 | Similar symptoms, not the exact reported flow |
| 2 | Partial signal — env starts but flow didn't trigger |
| 1 | Setup failed |
| 0 | Unreproducible (missing info, feature request, question) |
