# Design: Profile-based Target Repo Configuration

> **Status:** Draft — open for review.
> **Goal:** Make shin-watcher able to target any repository, while keeping `BerriAI/litellm` as the default with zero behaviour change for current users.

---

## Problem

Today, knowledge about the target repository is hardcoded in four separate files:

| File | What's hardcoded |
|---|---|
| `src/proxy.ts` | The clone URL, the `uv run litellm …` spawn command, the env vars (`LITELLM_MASTER_KEY`, `UI_USERNAME`, `UI_PASSWORD`), the `/health/readiness` endpoint |
| `skills/plan_repro.md` | The full reproduction recipe — admin API paths (`/team/new`, `/user/new`), JWT minting against `sk-1234`, navigation to `localhost:4000/ui/`, etc. |
| `src/prompts/repro.ts` | The phrase *"You are shin-watcher, an autonomous bug-reproduction agent for BerriAI/litellm"*, references to "the LiteLLM proxy", "the litellm clone" |
| `src/tools/beginReproRun.ts` | The literal subdirectory name `"litellm"` in the workdir path; the tool description says *"clone litellm here"* |

Anyone who wants to use shin-watcher on another repository has to fork and edit these four files at multiple call sites. There is no clean separation between the agent kernel and what is specific to a single target.

---

## Proposal: Profiles

A **profile** is a self-contained bundle describing how to work on one target repository. All target-specific knowledge — clone URL, start command, repro recipe, prompt addendum — lives inside a single profile folder.

```
profiles/
  litellm/
    config.yaml       # how to install, start, stop, health-check
    repro.md          # the full reproduction skill (was skills/plan_repro.md)
    prompt.md         # the system prompt addendum that introduces the target
```

The active profile is selected at startup via the `PROFILE` env var.

```bash
# default: profile=litellm (same behaviour as today)
PROFILE=litellm

# custom: target some other repo
PROFILE=my-service
```

If `PROFILE` is unset, the loader falls back to `litellm` so existing users see no change.

---

## Profile schema

`profiles/<name>/config.yaml`:

```yaml
# Identifier — must match the folder name.
name: litellm

# Source repository.
clone_url: https://github.com/BerriAI/litellm.git
default_ref: main

# Optional install step run after clone, before start.
install:
  command: uv sync --extra proxy

# Required: how to launch the service the agent will probe.
# {port}, {master_key}, {ui_username}, {ui_password} are interpolated at runtime
# from values generated per repro run.
start:
  command: uv run litellm --config proxy_server_config.yaml --port {port}
  env:
    LITELLM_MASTER_KEY: "{master_key}"
    UI_USERNAME: "{ui_username}"
    UI_PASSWORD: "{ui_password}"

# Required: how to know the service is ready.
health_check:
  url: http://localhost:{port}/health/readiness
  timeout_ms: 90000

# Optional: a browser-friendly URL the agent can navigate to.
ui_url: http://localhost:{port}/ui/
```

`profiles/<name>/repro.md`: free-form markdown skill, exactly the same shape as today's `skills/plan_repro.md`. Moved verbatim during migration.

`profiles/<name>/prompt.md`: free-form markdown that gets prepended to the system prompt, replacing the hardcoded `"You are shin-watcher, an autonomous bug-reproduction agent for BerriAI/litellm"` line.

---

## File structure changes

### New
- `profiles/litellm/config.yaml`
- `profiles/litellm/repro.md` (moved from `skills/plan_repro.md`)
- `profiles/litellm/prompt.md` (extracted from `src/prompts/repro.ts`)
- `src/profile.ts` (loader + schema validation)

### Modified
- `src/config.ts` — add `profile: required("PROFILE", "litellm")`; consider renaming `config.litellm` → `config.llm` for clarity (the keys under it route the agent's own LLM calls, not the target service)
- `src/proxy.ts` — `prepareWorkdir` and `startProxy` consume the active profile instead of hardcoding litellm specifics
- `src/prompts/repro.ts` — load `profile.prompt` instead of inlining the litellm sentence; replace literal `"litellm clone"` strings with profile-aware phrasing
- `src/tools/beginReproRun.ts` — replace the literal `"litellm"` subdirectory name with `profile.name`; update the tool description to be profile-agnostic

### Removed (because moved into the profile)
- `skills/plan_repro.md` (moves to `profiles/litellm/repro.md`)
- The `skills/` folder stays for skills that are not target-specific (e.g. `implement.md`)

---

## Backwards compatibility

A returning user who pulls this PR and runs `npm run once -- --issue 27105` with their existing `.env` should see the same behaviour as today. Concretely:

- `PROFILE` defaults to `litellm` if unset
- `profiles/litellm/` preserves the existing repro skill and the existing start command verbatim
- All current env vars (`LITELLM_*`, `TARGET_REPO_*`, etc.) keep their meaning
- No breaking changes to `.env.example`

A migration note will be added at the top of `README.md` so existing users know about the new `PROFILE` knob, but no action is required from them.

---

## Migration plan

The PR is structured as a sequence of small commits so reviewers can read it incrementally.

1. **Add `src/profile.ts`** — typed loader, schema validation, no callers yet
2. **Create `profiles/litellm/`** — move `skills/plan_repro.md` to `profiles/litellm/repro.md`, extract the litellm prompt into `profiles/litellm/prompt.md`, write the matching `config.yaml`
3. **Refactor `src/proxy.ts`** — `prepareWorkdir` and `startProxy` consume the active profile; behaviour identical for the litellm profile
4. **Refactor `src/prompts/repro.ts`** — load `profile.prompt` instead of inlining the litellm sentence
5. **Refactor `src/tools/beginReproRun.ts`** — replace literal `"litellm"` strings with `profile.name`
6. **Update `README.md` + `.env.example`** — document `PROFILE`, add a "Use with another repo" section
7. **Tests** — at minimum: a smoke test that the litellm profile still produces a valid spawn command; ideally a second profile fixture proving the genericity

Each commit keeps tests green so reviewers can bisect if anything breaks.

---

## What this doesn't change

- The agent kernel (Pi AI SDK loop, tool handlers, dashboard) stays untouched
- The `skills/implement.md` flow is unaffected (it's about applying fixes, not about the target service)
- The Slack bot integration, scheduler, GitHub MCP wiring — all unchanged
- The repro skill content for litellm stays byte-identical; it just moves into `profiles/litellm/repro.md`

---

## Known follow-ups (not in this PR)

The dashboard UI files (`src/dashboard/ui/index.html`, `src/dashboard/ui/runs.html`) still hardcode `litellm` and `BerriAI` in static markup and inline JavaScript. These are cosmetic — the agent runs correctly under any profile — but they should be made profile-aware in a follow-up. The change requires either templating the HTML at serve time or exposing the active target via a small `/api/target` endpoint that the JS reads on load. Out of scope for this PR to keep the diff focused on the agent architecture.

## Open questions for review

- Should `profile.repro` and `profile.prompt` be optional? A profile that only configures `start` + `health_check` and reuses a default skill could be valuable for simple cases.
- Should we ship a second example profile (e.g. a tiny FastAPI service) to demonstrate the genericity, or leave that to documentation?
- Is `PROFILE` the right env var name, or should it be something more specific like `SHIN_PROFILE` to avoid clashes?
