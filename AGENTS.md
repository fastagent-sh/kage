# kage — Agent Guide

## Product and authority

A native local-first workbench for FastAgent agents: create one with the contexts it works on and
knows, use it locally, give someone their own copy of the Agent, connect to your own or an invited
online instance, or optionally host it with kage cloud for scheduled work. Agents are contacts;
conversations and history belong to each FastAgent instance, not a kage transcript store. Only the
Week 1 local path is implemented.

Vocabulary follows FastAgent's agent model (`docs/design/agent-model.md` there): an **Agent** is the
definition (model, harness, contexts) in its own directory; an **instance** is one Agent running in
one place; a **context** is a directory it works on or knows. Do not say preset, workspace or
deployment for these.

- `README.md`: positioning and milestone scope.
- `docs/design.md`: product objects, surfaces and flows.
- `docs/interaction.md`: interaction behavior and failure presentation.
- `docs/architecture.md`: process boundaries and state ownership.
- `CONTRIBUTING.md`: authoritative GitHub, verification, review and merge workflow.

Distinguish requirements, implemented behavior and verified acceptance. An open issue may ask for
verification of existing code, not a rewrite. Resolve conflicting product policies explicitly.

## Boundaries

- Main owns runtimes, filesystem access and credentials. The renderer uses a typed preload API;
  do not expose unrestricted filesystem, IPC or shell access or weaken context isolation/CSP.
- Use FastAgent's public contracts, not private engine imports or another copy of its session store.
- Agent defaults and historical conversation settings are different. Model display, the model that
  executes and provider authentication must agree for each conversation.
- Drafts/live presentation state must not become a second durable transcript. Keep state and late
  async results attached to their originating agent, conversation and subscription.
- Preserve data-integrity protections and original errors. Never turn corrupt/unreadable state into
  an empty list, hide failure as a fallback, or automatically replay accepted tool work.
- No real credentials, private sessions or project contents in commits, CI or shared artifacts.
  Local real-provider and OAuth checks are fine; report them separately from mocked results.
- Follow the outcome-gated stages in `README.md`: local daily workbench, someone's own copy of an
  Agent, protected online contacts (including the owner's private scheduled work), optional hosting,
  then groups or discovery only if needed. Do not present planned screens or schedule outcomes as
  shipped.
- A copy of an Agent never carries secrets or runtime state (`.state/`). Remote invites require a host-side protected
  access boundary and per-visitor conversation isolation; never expose a raw FastAgent endpoint
  or instance-wide session list to visitors. No enterprise administration or audit UI.
- Avoid placeholder cloud UI, a built-in agent editor, permission prompts, remote file browsing or
  advanced session controls without a demonstrated product need.

## Working and verification

kage is early and has published unsigned macOS releases. Never add backward compatibility,
migrations, legacy-format detection or compatibility shims. When a format, layout or contract
changes, change the code, tests and docs to the new one and drop the old.

Read the affected path and callers first. Prefer existing helpers, the standard library and native
Electron/Chromium behavior; avoid speculative layers. Separate refactoring from behavior changes.
Add the smallest regression that exposes the failure, including proving protective checks can fail
when their protection is removed.

Write very few comments. Readers, including AI agents, understand code from its names and
structure; make those clear instead. Comment only what the code cannot show: a non-obvious reason,
an external constraint, or a workaround and its cause, in one or two lines. No comments or
docstrings that restate the code, narrate steps, label sections or record history. Delete such
comments in lines you change.

FastAgent is an exact npm version in `package.json` and the lockfile, never a local checkout or a
moving branch; `CONTRIBUTING.md` says how it is bumped.

```bash
npm test
npm run build
```

Verify relevant desktop interactions separately; mocked HTTP tests do not prove real OAuth or
proxy behavior. Update companion product docs and state limitations honestly.

## Collaboration

Use a focused prefixed branch and a PR, never a direct push to `main`. Preserve unrelated uncommitted
work; use an isolated worktree when necessary. Keep repository artifacts and GitHub discussion in
English. Link issues and provide actual evidence before closing acceptance criteria.

Read all review bodies, comments and inline threads, including paginated results. Resolve a thread
only after fixing/verifying it or explaining why it is declined. Report a green PR as ready and stop;
merge only when a maintainer explicitly authorizes it. See `CONTRIBUTING.md` for the current GitHub
plan's enforcement limitations; do not claim unenforced policy is branch protection.
