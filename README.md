# kage 🥷

[![CI](https://github.com/kid7st/kage/actions/workflows/ci.yml/badge.svg)](https://github.com/kid7st/kage/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-kage)](https://www.npmjs.com/package/pi-kage)
[![license](https://img.shields.io/npm/l/pi-kage)](./LICENSE)

> 影分身の術 — Shadow Clone Jutsu for your git repo. · [中文](./README.zh-CN.md)

<p align="center"><img src="./assets/demo.svg" alt="kage demo" width="100%"></p>

Run several AI coding-agent sessions on one repo at the same time. Point two agents at the same
checkout and they fight over one working tree — same files, same branches, each other's uncommitted
changes. kage gives each session its **own full copy** of the repo in a sibling folder, so they
can't collide.

```bash
npm install -g pi-kage
eval "$(kage shell-init)"   # let kage cd your shell in & out (recommended)
cd my-app
kage            # 🥷 copy → ../my-app--kage-<ts>, and cd you into it
#   ...work (pi/claude/codex, or whatever), commit, push, open a PR...
kage finish     # 💨 merge the clone's sessions back, delete the clone, cd you home
```

Code comes back through git (a PR, or a branch fetch). The agent's session memory comes back through
its own session store (`~/.pi`, `~/.claude`, or `~/.codex`). kage never copies a working tree back onto
the origin — that's the whole point.

## Why a full copy, not `git worktree`?

A [`git worktree`](https://git-scm.com/docs/git-worktree) gives you a second working directory, but
every worktree shares one `.git` — so two agents can't check out the same branch, and stash/refs/index
are shared. A worktree is also a clean checkout: no `node_modules`, `.env`, build cache, so each one
needs a setup pass first.

A full copy has independent `.git`, independent branches, and every gitignored/untracked file already
in place. The cost is disk and copy time — which on APFS (macOS) and reflink filesystems (Linux) kage
sidesteps with a copy-on-write clone: near-instant, no extra space until files actually change. Other
filesystems fall back to a plain recursive copy.

## Install

```bash
npm install -g pi-kage      # or: pnpm add -g pi-kage
npx pi-kage                 # run without installing

# install script (single zero-dependency Node script → ~/.local/bin)
curl -fsSL https://raw.githubusercontent.com/kid7st/kage/main/install.sh | sh
```

Requires **git** and **Node ≥ 18** on your `PATH`, plus at least one coding-agent CLI to drive —
[**pi**](https://github.com/earendil-works) (the default), [**Claude Code**](https://github.com/anthropics/claude-code),
or [**Codex**](https://github.com/openai/codex). kage itself has no runtime dependencies.

From source:

```bash
git clone https://github.com/kid7st/kage
cd kage && npm install && npm link   # npm install builds bin/kage.mjs from src/
```

## Usage

| Command | Run from | What it does |
|---|---|---|
| `kage [path] [--name x] [--agent pi\|claude\|codex]` | origin repo | Copy the repo to `../<repo>--<name>` (default `kage-<ts>`), copy in the origin's 5 most recent sessions for that agent (resumable, never replayed), and launch a **fresh** agent (pi by default). `--name` only names the folder — kage never creates a branch. No args + existing clones → interactive menu. |
| `kage status [--pr]` | origin repo | Dashboard: branch, dirty/clean, ahead/behind, "safe to clean". `--pr` adds PR state via `gh`. |
| `kage finish [name] [--force] [--push] [--pr]` | origin / inside clone | Refuse if the clone has uncommitted or unpushed work, merge its **new** sessions back, delete it. `--push` pushes the branch first; `--pr` pushes + opens a PR via `gh`; `--force` skips the guard. |
| `kage rm [name] [--force]` | origin / inside clone | Discard a clone **without** merging memory. Refuses local-only work unless `--force`. |
| `kage pull <path...>` | inside a clone | Copy specific files/dirs (even gitignored, e.g. a generated `.env`) back to the origin. |
| `kage config [<key> [value]] [--unset]` | anywhere | Get/set persisted defaults. One key today: `agent` (your default launch agent), validated against known agents. |
| `kage shell-init` | shell rc | Shell wrapper (cd into a clone on create, back to origin on `finish`/`rm`) + tab completion. Use `eval "$(kage shell-init)"`. |
| `kage --help` / `--version` | anywhere | Usage / version. |

Run bare `kage` inside a repo that already has clones to get an interactive picker: create a new clone,
or **enter** / **finish** / **remove** an existing one. `finish` and `rm` show the same picker when you
have several clones and don't name one.

## Agents

kage is agent-agnostic — and launching an agent is **opt-in**. By default `kage` just creates the clone and
cd's your shell into it; you work however you like. To have kage launch one for you, name it with `--agent`,
or set a default with `kage config agent` (or `$KAGE_AGENT`) — precedence `--agent` > `$KAGE_AGENT` >
`kage config agent`; with none set, nothing is launched. Whichever way you work, every agent gets the same
isolated clone and git flow-back — what differs is **memory flow-back**, i.e. whether the sessions you
create in the clone come home to the origin:

| Agent | Launch it with | Memory flow-back |
|---|---|---|
| **pi** | `kage --agent pi` | ✅ full round-trip — recent sessions copied in on create, new ones merged back on `finish` |
| **Claude Code** | `kage --agent claude` | ✅ full round-trip (same as pi) |
| **Codex** | `kage --agent codex` | ⚠️ git only — history stays global, reach it with `codex resume --all` |

**Why Codex is git-only.** pi and Claude Code key their session stores by working directory, so kage can
copy a clone's sessions over to the origin's directory and back. Codex keeps one global, sqlite-indexed
store that kage can't cleanly re-home — so `--agent codex` gives you the isolated clone + git flow-back,
and your Codex history stays globally reachable. Details in
[`docs/multi-agent-design.md`](./docs/multi-agent-design.md).

You can run several agents at once — a clone each, or different agents in one clone. Each agent uses its
own store, so they never collide, and `finish` merges back whichever stores gained new sessions.

**Driving a GUI/IDE agent kage can't spawn?** Use `--open <cmd>` to create the clone and open it yourself
(e.g. `kage --open code` runs `code <clone>`), or `--no-launch` to just make the clone and print its path.
Memory still flows for any agent whose store kage manages, no matter how you opened the clone.

## Shell integration (optional)

```bash
eval "$(kage shell-init)"   # add to ~/.zshrc or ~/.bashrc
```

`kage` cd's your shell **into** the new clone, and `finish`/`rm` cd it **back** to the origin afterward
(a CLI can't move its parent shell otherwise, so this needs the wrapper — without it, kage just prints the
`cd` for you to run). It also adds tab completion for subcommands and clone names.

## How it works

- **Isolation.** A clone is a full independent copy with its own `.git`. kage does **not** create a
  branch — the clone stays on the origin's current branch and stays out of git flow, so you own the
  branching/PR workflow inside the clone (tell the agent via your `AGENTS.md`).
- **Code flows back via git, never the working tree.** With a remote: push the branch, merge the PR.
  Without a remote: `finish` fetches the clone's branch into the origin's git as a local
  `kage/<name>-<sha>` branch (origin working tree untouched — `git merge` it when you like). Because a
  fetch can't preserve uncommitted work, `finish` refuses to delete a dirty clone unless `--force`.
- **Memory flows via the agent's own session store, never replayed.** On create, the origin's 5 most
  recent sessions for that agent are copied in — the agent's resume picker surfaces them when you launch it, but you
  start a **fresh** session. On `finish`, sessions the clone created come back whole; a copied-in session
  you resumed comes back as a separate new session, so the origin's original is never mutated. (Codex is
  the exception — git-only flow-back; see [Agents](#agents).)
- **The origin is read-only to kage.** It only copies out and writes session memory — it never touches
  the origin's working tree, even while another session is live there.

## Notes

- The copy snapshots the origin's **current** state, including uncommitted changes.
- **Submodules**: a submodule's `.git` is an absolute path and breaks on copy — run
  `git submodule update --init` in the clone.
- kage reads each agent's sessions from where that agent itself stores them, honoring the agent's own
  config var — `PI_CODING_AGENT_DIR` (pi), `CLAUDE_CONFIG_DIR` (Claude Code), `CODEX_HOME` (Codex) — so
  kage and the agent always agree on the location.

## Development

The CLI is TypeScript compiled to a single zero-dependency file:

- `src/kage.mts` → `bin/kage.mjs` (the only thing shipped)
- `test/kage.test.mts` → `dist/` — black-box `node:test` smoke tests that spawn the built CLI

`bin/` and `dist/` are gitignored build artifacts; `bin/` is produced on `npm install` (via `prepare`),
so `npm link` from a clone just works. Linting/formatting is [Biome](https://biomejs.dev) (dev-only).

```bash
npm run build    # tsc: src/kage.mts → bin/kage.mjs
npm run lint     # biome + tsc type check
npm test         # build + node:test smoke tests (temp repos, no network)
```

Releases: bump `version` in `package.json`, then `git tag vX.Y.Z && git push origin main vX.Y.Z`.
CI runs lint + tests and `npm publish --provenance` on any `v*` tag.

## License

[MIT](./LICENSE)
