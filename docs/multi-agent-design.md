# Multi-agent design — making the Shadow Clone Jutsu work for pi, Claude Code, and Codex

> Status: implemented (all three phases landed) · Author: design notes from the kage maintainers · Last updated: 2026-05-31
>
> **Correction (live testing, 2026-05-31):** the Codex adapter was redesigned. Live testing
> against Codex 0.135 found that current Codex drives its cwd-filtered resume picker from a
> versioned internal sqlite index (`state_5.sqlite`'s `threads.cwd`), not the rollout — so the
> original "rewrite the rollout's cwd in place" approach orphans the session. kage now does **not**
> manage Codex memory (Option A): `--agent codex` = isolation + git flow-back only; Codex history
> stays global (`codex resume --all`). Sections below are updated; pi and Claude Code are unchanged.

## 0. Why this document exists

Today kage is hardwired to one coding agent: [`pi`](https://github.com/earendil-works).
The CLI `spawn`s `pi`, and the "memory flows back" feature reads and writes `pi`'s session
files under `~/.pi/agent/sessions`. Everything else — the copy-on-write clone, the git
flow-back, `finish`/`rm`/`pull`, the status dashboard — is already agent-agnostic.

We want kage to be a **true** Shadow Clone Jutsu: spin up an isolated copy of a repo, work
in it with **whatever** coding agent you use (pi, Claude Code, Codex, …), and have that
agent's **memory flow in on create and back out on finish** — the same guarantee `pi` gets
today. This document is the design for that.

It also resolves three questions that surfaced while thinking it through:

1. Should the agent be recorded in the clone marker? (No.)
2. Is multiple agents on one repo a real use case? (Yes — and it makes the design *simpler*.)
3. Does "Codex" mean only the `codex` CLI, or the whole product including the Desktop/IDE
   client? (The whole product — and that distinction reshapes the design.)

## 1. Goals

- **A — Launch any agent in a clone.** Create the isolated clone, then start working in it
  with the agent of your choice.
- **B — Memory flows both ways.** On create, the origin's recent sessions for that agent are
  copied into the clone (resumable, never replayed). On finish, the sessions the clone
  created come back into the origin. This is the differentiator; it must work per agent.
- **Multi-agent.** Both "several clones, one agent each" and "one clone, several agents"
  must work without special-casing.
- **Client-agnostic memory.** Memory sync must not care whether you used a CLI, a VS Code
  extension, or a desktop app — only which agent's *store* the work landed in.

Non-goals (for now): cross-agent memory translation (pi memory cannot seed a Claude session
— the formats are incompatible), launching GUI clients *into* a working directory the way we
spawn a CLI, and full-fidelity capture of every sidecar artifact an agent writes.

## 2. The two axes: product vs. surface

A coding agent is a **product** (pi, Claude Code, Codex). Each product ships through one or
more **surfaces**: a terminal CLI, a VS Code / IDE extension, a desktop app, a cloud runner.

The key empirical finding (observed on a real machine):

- Every Codex session on the machine was written by `originator: "Codex Desktop",
  source: "vscode"` (versions `0.131`–`0.135`), **not** the installed `codex` CLI
  (`codex-cli 0.46.0`). The CLI had written zero sessions.
- Yet all of those Desktop/VS Code sessions land in the **same** `~/.codex/sessions/` tree,
  in the **same** rollout format the CLI uses.

So a product's **session store is shared across its surfaces**. The `originator`/`source`
fields are just provenance. The same holds for Claude Code (the CLI and the VS Code
extension both write to `~/.claude/projects/<cwd>/`).

This splits cleanly along the A/B line:

| Concern | Granularity | Consequence for kage |
|---|---|---|
| **B — memory** | per **product** | Client-agnostic. kage syncs the *store*; it doesn't matter if a CLI, an extension, or a desktop app wrote the sessions. **Free for GUI users.** |
| **A — launch** | per **surface** | Only a CLI can be `spawn`ed into a `cwd` and waited on. A desktop app or IDE extension cannot. Launch is therefore an optional, detachable convenience — not part of the core. |

**The architectural decision that follows:** keep the memory adapter and the launch step
**separate**. kage's irreducible value is *isolated clone + per-`cwd` memory sync*, which is
client-agnostic. Auto-spawning a CLI is a convenience layer for CLI users only.

## 3. Architecture overview

```
┌──────────────────────────────────────────────────────────────┐
│ agent-agnostic core  (existing; barely changes)               │
│   copyRepo · marker · git flow-back · finish / rm / pull       │
│   status · pickClone · interactive menu · shell-init           │
└───────────────┬───────────────────────────────┬──────────────┘
                │ memory (B)                     │ launch (A)
        ┌───────▼────────┐               ┌───────▼─────────┐
        │ SessionStore    │  registry     │ launch step      │  one of:
        │  (per product)  │ = {pi,        │  (optional, thin)│   · spawn CLI (default)
        └───────┬────────┘   claude,      └─────────────────┘   · --open <cmd>
       ┌────────┴────────┐   codex}                              · --no-launch
       ▼                 ▼
  DirStore family    Codex family
  (pi, claude)       (flat global)
```

Two abstractions, deliberately separate:

- **`SessionStore`** — one per *product*. Knows how to read/write that product's session
  store keyed by working directory. This is the whole of feature B and is client-agnostic.
- **launch** — an optional, thin step orthogonal to the store. Spawn a CLI (today's default),
  run an `--open` command (e.g. `code <clone>`), or do nothing (`--no-launch`).

## 4. The `SessionStore` abstraction

```ts
interface SessionStore {
  id: "pi" | "claude" | "codex";

  /** Copy the origin's recent sessions into the clone so the agent can resume them there.
   *  Returns how many were imported (0 = nothing to import / not applicable). */
  importHistory(originRepo: string, cloneDir: string): number;

  /** Merge the sessions the clone created back into the origin. Returns the count. */
  mergeBack(cloneDir: string, originRepo: string): number;

  /** Discard the clone's sessions without merging (used by `kage rm`). */
  discard(cloneDir: string): void;

  /** Does this store have any sessions for `cwd`? Used by status + the re-enter menu. */
  hasActivity(cwd: string): boolean;
}
```

`pi` and `claude` are produced by a shared `dirStore(config)` factory; `codex` is a
standalone implementation. They fall into two structurally different families.

### 4.1 DirStore family — "cwd → directory" (pi, claude)

A clone is a new working directory, so its store directory starts empty and the origin's
history is invisible there — therefore copy-in is **required**. This is exactly today's
`pi` logic (`copyOriginHistory` / `mergeBack`), parameterized at six points:

| Parameter | pi | Claude Code |
|---|---|---|
| `baseDir` (env override) | `~/.pi/agent/sessions` (`PI_CODING_AGENT_DIR`/sessions) | `~/.claude/projects` (`CLAUDE_CONFIG_DIR`/projects) |
| `encodeCwd(abs)` | `--a-b--` (replace `/`, keep `.`, wrap in `--`) | replace every non-alphanumeric with `-`: `/U/me/.x` → `-U-me--x` |
| `dirFor(cwd)` | `join(baseDir, encodeCwd(cwd))` | same shape |
| cwd-rewrite scope | first line (header) only | **every line** carries `cwd` |
| dedup key | per-line `id` | per-line `uuid` |
| identity / filename | `<ts>_<uuid>.jsonl`, id in header `id` | `<sessionId>.jsonl`, `sessionId` on every line |

**`importHistory`** (generic): take the most recent `N` (=5) `.jsonl` from `dirFor(origin)`
by mtime → rewrite cwd to the clone → write into `dirFor(clone)` under the same filename.

**`mergeBack`** (generic — today's `pi` logic):
- session file not present in the origin's dir → the clone created it → rewrite cwd, copy back.
- present (a copied-in origin session) and unchanged → skip (adds nothing).
- present and the clone added records (dedup by key) → write back as a **new, self-contained**
  session (fresh identity + cwd → origin), so the origin's original file and the leaf the
  agent would resume are never mutated.

> **Claude's "write back as new" needs one extra hook.** Because the filename *is* the
> `sessionId` and every line repeats it, writing a resumed-and-extended session back as a new
> file means regenerating the `sessionId` across all lines and renaming the file. The DirStore
> config gets a `reidentify(lines, newId)` hook: pi sets `header.id`; claude rewrites
> `sessionId` on every line and derives `<newId>.jsonl`.

### 4.2 Codex family — "flat global store, cwd is a content field"

Codex stores rollouts at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (env `CODEX_HOME`),
organized **by date, not by cwd**. The working directory lives in the first line's
`session_meta.payload.cwd`. Origin and clone write into the **same** global tree. There is
also a global `~/.codex/session_index.jsonl` (`{id, thread_name, updated_at}`, no cwd).

- **`listFor(cwd)`** = scan rollouts (limited to recent date dirs) and keep those whose
  `payload.cwd === cwd`.
- **`importHistory` = no-op.** Codex 0.46's resume picker is global (its `resume --help` has
  no `--all`/`--cwd`), so the origin's history is already visible from inside the clone.
  Newer Codex versions filter the picker by cwd; those users run `codex resume --all`. We do
  **not** fabricate copy-in rollouts — that would require minting new UUIDs and editing
  `session_index.jsonl`, fighting Codex's storage model.
- **`mergeBack` = no-op** (and **`discard` = no-op**). Originally this was an in-place
  `payload.cwd` rewrite — correct for Codex **0.46** (no cwd index). But Codex **0.135** keys its
  cwd-filtered resume picker off a *versioned internal sqlite index* (`state_5.sqlite`'s
  `threads.cwd`), **not** the rollout. Rewriting only the rollout leaves that index pointing at
  the now-deleted clone, so the "merged-back" session is orphaned and rollout/index disagree.
  Updating the sqlite would couple kage to an undocumented, version-moving schema and need a
  sqlite runtime dependency it avoids. **So kage does not manage Codex memory** (Option A).
- **`hasActivity`** = scan rollouts for `payload.cwd === cwd` (never the sqlite); used only by
  the re-enter menu while a clone still exists.

> Codex's global, sqlite-indexed store means kage can't cleanly re-home a clone's sessions to the
> origin cwd. Rather than write Codex's internal DB, kage leaves the store entirely alone:
> `--agent codex` gives the isolated clone + git flow-back, and Codex history stays globally
> available via `codex resume --all`. The cwd-rewrite design was a Codex-0.46 assumption that
> broke on 0.13x.

### 4.3 Adapter cheat-sheet

| | pi | Claude Code | Codex |
|---|---|---|---|
| store | `~/.pi/agent/sessions/<enc>/` | `~/.claude/projects/<enc>/` | `~/.codex/sessions/Y/M/D/` |
| env | `PI_CODING_AGENT_DIR` | `CLAUDE_CONFIG_DIR` | `CODEX_HOME` |
| keyed by | cwd (directory) | cwd (directory) | date (cwd is a field) |
| import | copy-in + rewrite header cwd | copy-in + rewrite every-line cwd | **no-op** |
| mergeBack | copy-out + dedup | copy-out + dedup (+ reidentify) | **no-op** (not kage-managed) |
| family | DirStore | DirStore | Codex |

## 5. Launch (the detachable A)

Launch is orthogonal to the store and has three modes:

- **CLI spawn** (default, today's behavior): `spawn` the agent's terminal binary in the clone,
  inherit stdio, block until it exits, then print the `kage finish` hint. Applies to CLI
  surfaces (`pi`, the `claude` CLI, the `codex` CLI).
- **`--open <cmd>`**: create the clone, sync memory in, run `<cmd> <clone>` (e.g.
  `kage --open code` → `code <clone>`), and **return immediately**. For IDE/desktop users.
- **`--no-launch`**: create the clone, sync memory in, print the path, return. You open it
  however you like.

Selection of *which* agent's CLI to spawn: `--agent <id>` > `KAGE_AGENT` env > default `pi`.

> **GUI flow caveat.** `--open`/`--no-launch` are non-blocking, so kage cannot detect when
> you are "done" and cannot print the post-exit prompt the CLI flow does. You run `kage finish`
> yourself when ready — which is already how `finish` is designed (a separate command driven
> by probing the stores, independent of how the work was produced).

## 6. Multi-agent model

Memory sync is **set-based**: it iterates the store registry, and each store is a no-op when
it has nothing for the relevant `cwd`.

- create: `for (const s of STORES) s.importHistory(origin, clone)`
- finish: `for (const s of STORES) s.mergeBack(clone, origin)`
- rm: `for (const s of STORES) s.discard(clone)`

This makes both multi-agent flavors work with **no special-casing**:

- **Several clones, one agent each** (clone A = pi, clone B = claude, clone C = codex). Each
  clone has its own `cwd`; `finish` probes every store for that `cwd`, merges the one that has
  work, and no-ops the rest.
- **One clone, several agents** (pi, then claude, then codex on the same code). The three
  products use three different stores, so they coexist under one `cwd` without collision;
  `finish` merges each store independently.
- **Multiple Codex clones in parallel** (the riskiest case, since Codex's store is one global
  tree): the `payload.cwd` partition key keeps each clone's rollouts separate.

**Inherent limit: no cross-agent memory inheritance.** If the origin only has pi history and
you open a Claude clone, Claude cannot read pi's format — `importHistory` finds nothing and
the clone starts genuinely fresh. After finish, that Claude work settles into the origin's
*Claude* store, so the next Claude clone inherits it. Over time the origin accumulates
**per-agent buckets** of memory, each reflecting the work done with that agent. This is
self-consistent and honest, not a bug.

## 7. The clone marker — unchanged

The marker (`.kage.json`) carries the one thing nothing else encodes: **"this folder is a
kage clone, and its local origin is X."** (A clone is a `cp -R`, so its git remotes point at
GitHub, not the local origin; and inferring the origin from the `<repo>--<name>` folder name
is ambiguous when the repo name contains `--`, when the folder is renamed, or when a
coincidental `<repo>--something` sibling exists.) It is load-bearing for `finish`, `rm`,
`pull`, status-from-inside-a-clone, and clone discovery.

The agent does **not** belong in the marker. `finish`/`rm` and the re-enter menu learn which
agents are relevant by probing the stores (`hasActivity`), not by reading a pinned field. So:

```jsonc
{ "originRepo": "...", "name": "...", "createdAt": "..." }  // status quo — no `agent` field
```

The marker needs **no change**.

## 8. CLI / UX changes

- `kage [path] [--name x] [--agent pi|claude|codex] [--open <cmd>] [--no-launch]`
  - `--agent` selects which CLI to spawn (only meaningful for CLI launch); precedence
    `--agent` > `KAGE_AGENT` > `pi`.
  - `--open <cmd>` / `--no-launch` switch the launch mode (§5).
- **Re-enter menu** (bare `kage` inside a repo with clones): replace the hardcoded
  "Enter (resume pi)" with the agents that have activity for that clone's `cwd`
  (`hasActivity`), letting you choose which to resume; fall back to the default agent + a
  fresh session when none have activity.
- **`kage status`** may show, per clone, which agents have activity (e.g. `pi ✓ codex ✓`).
  Because Codex requires scanning its global tree and its picker is known to slow down with
  many sessions, make this **opt-in** (like `--pr`) or bound it to recent date dirs — never
  slow the default dashboard.
- **`finish`** sums the per-store merge counts in its closing line, e.g.
  `merged 3 session(s) back (pi 2, codex 1)`.

## 9. Data-flow walkthroughs

**create** (`kage --agent claude`): copy repo → `for s: s.importHistory(origin, clone)`
(pi/claude copy history in, codex no-ops) → write marker → launch the `claude` CLI fresh
(or `--open`/`--no-launch`).

**finish** (DirStore family): preserve git work (push / PR / local `kage/<name>-<sha>` branch)
→ `for s: s.mergeBack` → pi/claude copy-out from `dirFor(cloneCwd)` (which lives under `$HOME`,
not under the clone dir) back into the origin's bucket and clear the clone's bucket → delete the
clone directory.

**finish** (Codex): nothing — Codex memory is not kage-managed (its global, sqlite-indexed store
can't be cleanly re-homed; see §4.2). The clone's Codex sessions stay in the global store and
remain reachable via `codex resume --all`.

## 10. Edge cases & failure modes

- **Codex store untouched.** kage never reads or writes Codex's global store on finish/rm, so
  concurrent Codex sessions (the origin's, or other clones') are never at risk.
- **Claude sidecar artifacts** (`subagents/`, `tool-results/`, file-history). MVP copies the
  main `<sessionId>.jsonl` only (matching today's pi behavior); spilled large tool outputs are
  not transferred. Documented fidelity trade-off, revisitable later.
- **Agent CLI not installed.** `--agent X` with `X` absent from `PATH` reuses today's ENOENT
  style failure: a clear "X not found" rather than a silent fallback.
- **Import scoping.** `importHistory` only runs for stores that actually have origin history,
  so no empty store directories are created for agents you have never used on that repo.

## 11. Implementation plan

Each phase is independently shippable.

- **Phase 1 — abstraction, zero behavior change.** Extract `SessionStore` + a `STORES`
  registry; move today's pi logic into `dirStore`; replace `launchPi` with a `launch` step
  that supports all three modes (CLI spawn / `--open` / `--no-launch`), defaulting to CLI
  spawn; make create/finish/rm iterate `STORES`. Register **only pi**, so output and tests are
  identical. Add `--agent`/`KAGE_AGENT` parsing (accepts only `pi` for now).
  **Acceptance: the existing 15 tests stay green.**
- **Phase 2 — Claude Code store.** Fill in the DirStore config for claude (encoding,
  every-line cwd rewrite, `reidentify`). **Acceptance: claude-flavored tests for import,
  mergeBack, and the resumed-copy-in case — fake `claude` binary + `CLAUDE_CONFIG_DIR`
  redirected to a temp dir + fabricated `.jsonl`.**
- **Phase 3 — Codex.** Registered with its CLI (`codex` / `codex resume --last`), but **not
  memory-managed**: live testing against Codex 0.135 showed the cwd-filtered resume picker is
  driven by a versioned internal sqlite index (`state_5.sqlite`'s `threads.cwd`), not the rollout,
  so an in-place rollout rewrite orphans the session (see §4.2). `importHistory` / `mergeBack` /
  `discard` are no-ops; `hasActivity` (rollout scan) powers the re-enter menu. **Acceptance:
  `CODEX_HOME` redirected; assert `kage finish` leaves a seeded Codex rollout byte-for-byte
  untouched.**

## 12. Testing strategy

Reuse the existing black-box harness (`run(CLI)` + temp repo + fake binary on `PATH` +
redirected store env + fabricated session files). For each store add: (1) import places the
origin's history into the clone; (2) the clone's new sessions merge back without duplication;
(3) resuming a copied-in session and adding turns writes back as a new, self-contained session
without mutating the origin; (4) Codex-only — the `cwd` partition never cross-contaminates.
No real agents are launched and there is no network access.

## 13. Decisions and open items

**Decided:**
- Agent selection: `--agent` + `KAGE_AGENT` + default `pi`; **no auto-detection**.
- Codex is **not memory-managed** (Option A): its global store keys the resume picker off a
  versioned internal sqlite index (`state_5.sqlite`'s `threads.cwd`, found via live testing on
  0.135), which kage won't rewrite (fragile + a runtime dep it avoids). `--agent codex` =
  isolation + git flow-back; Codex history stays global (`codex resume --all`). An earlier draft
  did an in-place rollout cwd rewrite — correct for 0.46, broken on 0.13x.
- Codex *is* registered with a launchable CLI (`codex resume --last`) — a deliberate change
  from an earlier "no Codex launch" note: it costs one line and helps CLI users, while
  desktop/IDE users use `--open`/`--no-launch`.
- Memory adapter and launch are **separate**; launch is optional with three modes
  (default spawn / `--open <cmd>` / `--no-launch`). `--no-launch` is the primitive for
  GUI/desktop apps you open yourself; `--open` is sugar for editors.
- The marker is unchanged (no `agent` field).
- Tests are hermetic: `run()` redirects every agent's store (`PI_CODING_AGENT_DIR`,
  `CLAUDE_CONFIG_DIR`, `CODEX_HOME`) under the test's temp dir, so the suite never touches a
  real `~/.codex` / `~/.claude`.
- Each agent's store override is the agent's **own** native var (no kage-specific
  `KAGE_SESSIONS_DIR`), so kage and the agent never disagree on where sessions live.

**Open (non-blocking):**
- Full-fidelity Claude sidecar transfer (`subagents/`, `tool-results/`).
- Whether the per-clone "agents with activity" column is shown by default in `status`.
- Whether to add deep-link launch for desktop apps if/when they expose one (beyond `--open`).
