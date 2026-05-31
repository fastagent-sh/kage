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
cd my-app
kage            # 🥷 copy → ../my-app--kage-<ts>, open a fresh pi
#   ...commit, push, open a PR, quit pi...
kage finish     # 💨 merge the clone's sessions back, delete the clone
```

Code comes back through git (a PR, or a branch fetch). The agent's session memory comes back through
`~/.pi`. kage never copies a working tree back onto the origin — that's the whole point.

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

Requires **git**, [**pi**](https://github.com/earendil-works), and **Node ≥ 18** on your `PATH`.
kage has no runtime dependencies.

From source:

```bash
git clone https://github.com/kid7st/kage
cd kage && npm install && npm link   # npm install builds bin/kage.mjs from src/
```

## Commands

| Command | Run from | What it does |
|---|---|---|
| `kage [path] [--name x]` | origin repo | Copy the repo to `../<repo>--<name>` (default `kage-<ts>`), copy in the origin's 5 most recent pi sessions (resumable, never replayed), and launch a **fresh** pi. `--name` only names the folder — kage never creates a branch. No args + existing clones → interactive menu. |
| `kage status [--pr]` | origin repo | Dashboard: branch, dirty/clean, ahead/behind, "safe to clean". `--pr` adds PR state via `gh`. (`kage list` is an alias.) |
| `kage finish [name] [--force] [--push] [--pr]` | origin / inside clone | Refuse if the clone has uncommitted or unpushed work, merge its **new** sessions back, delete it. `--push` pushes the branch first; `--pr` pushes + opens a PR via `gh`; `--force` skips the guard. |
| `kage rm [name] [--force]` | origin / inside clone | Discard a clone **without** merging memory. Refuses local-only work unless `--force`. |
| `kage pull <path...>` | inside a clone | Copy specific files/dirs (even gitignored, e.g. a generated `.env`) back to the origin. |
| `kage shell-init` | shell rc | Shell wrapper (cd back to origin after `finish`/`rm`) + tab completion. Use `eval "$(kage shell-init)"`. |
| `kage --help` / `--version` | anywhere | Usage / version. |

Run bare `kage` inside a repo that already has clones to get an interactive picker: create a new clone,
or **enter** / **finish** / **remove** an existing one. `finish` and `rm` show the same picker when you
have several clones and don't name one.

### Shell integration (optional)

```bash
eval "$(kage shell-init)"   # add to ~/.zshrc or ~/.bashrc
```

Running `finish`/`rm` from inside a clone deletes the directory your shell is sitting in. The wrapper
cd's you back to the origin automatically (a CLI can't change its parent shell otherwise) and adds tab
completion for subcommands and clone names.

## How it works

- **Isolation.** A clone is a full independent copy with its own `.git`. kage does **not** create a
  branch — the clone stays on the origin's current branch and stays out of git flow, so you own the
  branching/PR workflow inside the clone (tell the agent via your `AGENTS.md`).
- **Code flows back via git, never the working tree.** With a remote: push the branch, merge the PR.
  Without a remote: `finish` fetches the clone's branch into the origin's git as a local
  `kage/<name>-<sha>` branch (origin working tree untouched — `git merge` it when you like). Because a
  fetch can't preserve uncommitted work, `finish` refuses to delete a dirty clone unless `--force`.
- **Memory flows via `~/.pi`, never replayed.** On create, the origin's 5 most recent sessions are
  copied in — pi's resume picker surfaces them, but the clone opens a **fresh** session. On `finish`,
  sessions the clone created come back whole; a copied-in session you resumed comes back as a separate
  new session, so the origin's original is never mutated.
- **The origin is read-only to kage.** It only copies out and writes session memory — it never touches
  the origin's working tree, even while another session is live there.

## Notes

- The copy snapshots the origin's **current** state, including uncommitted changes.
- **Submodules**: a submodule's `.git` is an absolute path and breaks on copy — run
  `git submodule update --init` in the clone.
- Session storage defaults to `~/.pi/agent/sessions`; override with `KAGE_SESSIONS_DIR`.

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
