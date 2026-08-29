#!/usr/bin/env node
/**
 * kage 🥷 — cast the Shadow Clone Jutsu on a git repo.
 *
 * Copy the current repo into an isolated sibling folder (its own working tree and .git) and cd
 * into it; optionally launch a coding agent there. `kage finish` merges the agent's session memory
 * back into the origin and deletes the clone. Run `kage --help` for the command surface.
 *
 * Design invariants:
 *   1. Isolation   — a clone is a full independent copy (its own .git).
 *   2. Code flows back via git only — a remote PR, or (no remote) a fetch of the clone's branch
 *      into the origin's git on finish; kage never copies the working tree back onto the origin.
 *   3. Memory flows via each agent's own session store (pi/Claude Code keyed by cwd; Codex is
 *      launch-only, not kage-managed) — the origin's history is copied into the clone on create
 *      (resumable, never replayed) and the clone's new sessions are merged back on finish. These
 *      are session files, not the working tree, so there's no collision.
 *   4. The origin's working tree is read-only to kage — it only copies out, writes the kage/<name>
 *      branch into the origin's git (no-remote finish), and writes session memory.
 *
 * Launch is opt-in and detachable (see docs/multi-agent-design.md): with no agent named
 * (--agent / $KAGE_AGENT / `kage config agent`), kage just creates the clone and cd's you in.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Key } from "node:readline";
import readline from "node:readline";

const VERSION = "0.6.0"; // keep in sync with package.json (enforced by test)
const MARKER = ".kage.json";
const RECENT_SESSIONS = 5; // how many of the origin's most-recent sessions to copy into a clone

// ── types ────────────────────────────────────────────────────────────────────
interface Marker {
	originRepo: string;
	name: string;
	createdAt: string;
}
interface Clone {
	dir: string;
	name: string;
	marker: Marker;
}
interface ShResult {
	ok: boolean;
	out: string;
	err: string;
}
interface LastCommit {
	sha: string;
	subject: string;
	when: string;
}
interface CloneStatus {
	branch: string;
	dirty: boolean;
	dirtyCount: number;
	added: number;
	removed: number;
	ahead: number;
	behind: number;
	hasUpstream: boolean;
	lastCommit?: LastCommit;
}
interface Pr {
	state: string;
	number: number;
	url: string;
}
type Flags = Record<string, string | boolean>;
interface ParsedArgs {
	positional: string[];
	flags: Flags;
}
/** A string colorizer — paint.* and the PR color map share this shape. */
type Paint = (s: string) => string;
/** Typed accessors for the loose flags bag, so consumers don't re-derive the shape inline. */
const boolFlag = (flags: Flags, name: string): boolean => Boolean(flags[name]);
const strFlag = (flags: Flags, name: string): string | undefined => {
	const v = flags[name];
	return typeof v === "string" ? v : undefined;
};
/** A pi session .jsonl header record (first line); kept loose since we only touch a few fields. */
interface SessionHeader {
	id?: string;
	cwd?: string;
	[key: string]: unknown;
}

// ── output helpers ───────────────────────────────────────────────────────────
const TTY = process.stderr.isTTY;
const col = (code: string, s: string): string => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const paint = {
	bold: (s: string) => col("1", s),
	dim: (s: string) => col("90", s),
	red: (s: string) => col("31", s),
	green: (s: string) => col("32", s),
	yellow: (s: string) => col("33", s),
	magenta: (s: string) => col("35", s),
	cyan: (s: string) => col("36", s),
};
const info = (msg: string): void => console.error(msg);
// A function declaration (not an arrow const) so its `never` return type drives
// TypeScript's control-flow narrowing at call sites (`if (!x) die(...)` -> x is defined).
function die(msg: string): never {
	console.error(`✗ ${msg}`);
	process.exit(1);
}

// ── shell / git helpers ──────────────────────────────────────────────────────
function sh(cmd: string, args: string[], opts: { cwd?: string } = {}): ShResult {
	// `encoding: "utf8"` selects spawnSync's string overload, so stdout/stderr are typed strings.
	const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
	return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
const git = (cwd: string, args: string[]): ShResult => sh("git", args, { cwd });

function repoTopLevel(cwd: string): string | undefined {
	const r = git(cwd, ["rev-parse", "--show-toplevel"]);
	return r.ok ? r.out : undefined;
}

/** Validate parsed JSON has the shape kage writes (all three fields are strings). */
function isMarker(v: unknown): v is Marker {
	if (typeof v !== "object" || v === null) return false;
	const m = v as Record<string, unknown>;
	return typeof m.originRepo === "string" && typeof m.name === "string" && typeof m.createdAt === "string";
}

function readMarker(dir: string): Marker | undefined {
	const p = join(dir, MARKER);
	if (!existsSync(p)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
		return isMarker(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

// ── global config (~/.config/kage/config.json) ──────────────────────────
// kage's only persisted state besides the per-clone marker. Honors $XDG_CONFIG_HOME so it's
// overridable (and hermetic in tests) without a kage-specific env var. Launch is opt-in; the agent
// to launch (if any) is --agent > $KAGE_AGENT > config.agent, else kage just cd's you into the clone.
interface Config {
	agent?: string;
}
const CONFIG_KEYS = ["agent"] as const;
type ConfigKey = (typeof CONFIG_KEYS)[number];

function configPath(): string {
	const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
	return join(base, "kage", "config.json");
}
function readConfig(): Config {
	const p = configPath();
	if (!existsSync(p)) return {};
	try {
		const v: unknown = JSON.parse(readFileSync(p, "utf8"));
		if (typeof v !== "object" || v === null) return {};
		const o = v as Record<string, unknown>;
		const cfg: Config = {};
		if (typeof o.agent === "string") cfg.agent = o.agent;
		return cfg;
	} catch {
		return {};
	}
}
function writeConfig(cfg: Config): void {
	const p = configPath();
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`);
}

/** Copy a whole directory: clonefile on macOS, reflink on Linux, plain copy as fallback. */
function copyTree(src: string, dst: string): ShResult {
	const isMac = process.platform === "darwin";
	let r = sh("cp", isMac ? ["-c", "-R", src, dst] : ["--reflink=auto", "-R", src, dst]);
	if (!r.ok) r = sh("cp", ["-R", src, dst]);
	return r;
}

/** An indeterminate spinner on stderr (no-op when not a TTY). Returns { stop() }. */
function spinner(label: string): { stop(): void } {
	if (!process.stderr.isTTY) return { stop() {} };
	const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	const t0 = Date.now();
	let i = 0;
	const tick = () => {
		const s = ((Date.now() - t0) / 1000).toFixed(1);
		i = (i + 1) % frames.length;
		process.stderr.write(`\r\x1b[2K${paint.cyan(frames[i] ?? "")} ${label} ${paint.dim(`${s}s`)}`);
	};
	tick();
	const id = setInterval(tick, 80);
	return {
		stop() {
			clearInterval(id);
			process.stderr.write("\r\x1b[2K");
		},
	};
}

/** Copy the repo with a spinner (the copy can be slow on non-reflink filesystems). */
async function copyRepo(src: string, dst: string): Promise<{ ok: boolean; err: string }> {
	const isMac = process.platform === "darwin";
	const primary = isMac ? ["-c", "-R", src, dst] : ["--reflink=auto", "-R", src, dst];
	const tryCp = (args: string[]) =>
		new Promise<{ ok: boolean; err: string }>((res) => {
			const p = spawn("cp", args, { stdio: ["ignore", "ignore", "pipe"] });
			let err = "";
			p.stderr?.on("data", (d) => (err += d));
			p.on("error", (e) => res({ ok: false, err: e.message }));
			p.on("close", (code) => res({ ok: code === 0, err: err.trim() }));
		});
	const sp = spinner(`copying ${basename(dst)}`);
	let r = await tryCp(primary);
	if (!r.ok) r = await tryCp(["-R", src, dst]);
	sp.stop();
	return r;
}

const NAME_ADJECTIVES = ["swift", "brave", "calm", "keen", "bold", "warm", "quiet", "sharp", "light", "quick", "still", "deep"] as const;
const NAME_NOUNS = ["otter", "heron", "ember", "cedar", "lark", "reef", "finch", "moss", "dune", "vale", "wren", "flint"] as const;

/**
 * A short, sayable clone name like `swift-heron`.
 *
 * The name becomes the folder suffix, the terminal tab title you scan while several
 * clones run side by side, and the `kage/<name>-<sha>` ref `finish` leaves behind.
 * A timestamp served none of those: same-day clones differed only in their trailing
 * digits — the hardest thing to tell apart at a glance — and it could not be said
 * out loud. `isTaken` lets the caller skip names whose folder already exists.
 */
function autoName(isTaken: (name: string) => boolean = () => false): string {
	const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)] as T;
	const draw = () => `${pick(NAME_ADJECTIVES)}-${pick(NAME_NOUNS)}`;
	let name = draw();
	// 144 pairs, so a collision is rare; if every draw is taken the caller's own
	// "directory already exists" check reports it rather than us inventing a name.
	for (let i = 0; i < 20 && isTaken(name); i++) name = draw();
	return name;
}

/**
 * Sanitize a clone name into a slug that's safe as both a folder suffix and a git branch/ref:
 * ref-illegal chars (spaces, /, ~^:?*[\\, etc.) -> '-', no '..', no leading/trailing '-'/'.',
 * no trailing '.lock'. Falls back to a generated name if it sanitizes to empty.
 */
function slug(name: string): string {
	const s = name
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/\.{2,}/g, ".")
		.replace(/-{2,}/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
		.replace(/\.lock$/i, "-lock");
	return s || autoName();
}

function parseArgs(argv: string[]): ParsedArgs {
	const positional: string[] = [];
	const flags: Flags = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === undefined) continue; // unreachable (bounded loop), but proves index safety to the checker
		if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			const next = argv[i + 1];
			if (eq >= 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
			else if (next !== undefined && !next.startsWith("--")) {
				flags[a.slice(2)] = next;
				i++;
			} else flags[a.slice(2)] = true;
		} else positional.push(a);
	}
	return { positional, flags };
}

// ── clone discovery & status ─────────────────────────────────────────────────
function listClones(originRepo: string): Clone[] {
	const parent = dirname(originRepo);
	const out: Clone[] = [];
	for (const name of readdirSync(parent)) {
		const dir = join(parent, name);
		const m = readMarker(dir);
		if (m && m.originRepo === originRepo) out.push({ dir, name: m.name, marker: m });
	}
	return out;
}

function cloneStatus(dir: string): CloneStatus {
	const branch = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).out || "?";
	const st = git(dir, ["status", "--porcelain"]).out;
	const changed = st.split("\n").filter((l) => l.trim() && l.slice(3).trim() !== MARKER);
	const dirty = changed.length > 0;
	const up = git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
	let ahead = 0;
	let behind = 0;
	if (up.ok) {
		const rl = git(dir, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
		if (rl.ok) {
			const [b, a] = rl.out.split(/\s+/).map(Number);
			behind = b || 0;
			ahead = a || 0;
		}
	}
	// uncommitted line changes (tracked, vs HEAD) and the last commit on this branch
	const ss = git(dir, ["diff", "HEAD", "--shortstat"]).out;
	const added = Number(ss.match(/(\d+) insertion/)?.[1] || 0);
	const removed = Number(ss.match(/(\d+) deletion/)?.[1] || 0);
	const lc = git(dir, ["log", "-1", "--format=%h\x1f%s\x1f%cr"]).out;
	const [sha = "", subject = "", when = ""] = lc ? lc.split("\x1f") : [];
	const lastCommit: LastCommit | undefined = sha ? { sha, subject, when } : undefined;
	return { branch, dirty, dirtyCount: changed.length, added, removed, ahead, behind, hasUpstream: up.ok, lastCommit };
}

/** Compact relative age, e.g. "2h ago". */
function ago(date: string): string {
	const s = Math.max(0, (Date.now() - new Date(date).getTime()) / 1000);
	if (s < 60) return `${Math.floor(s)}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

/** Best-effort PR lookup via gh; returns { state, number, url } or undefined. */
/** Validate `gh pr view --json` output has the fields we read. */
function isPr(v: unknown): v is Pr {
	if (typeof v !== "object" || v === null) return false;
	const p = v as Record<string, unknown>;
	return typeof p.state === "string" && typeof p.number === "number" && typeof p.url === "string";
}

function prInfo(dir: string, branch: string): Pr | undefined {
	const r = sh("gh", ["pr", "view", branch, "--json", "state,number,url"], { cwd: dir });
	if (!r.ok) return undefined;
	try {
		const parsed: unknown = JSON.parse(r.out);
		return isPr(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** True when the clone has no local-only work (clean + pushed) -> safe to remove. */
const isSafeToClean = (s: CloneStatus): boolean => !s.dirty && s.hasUpstream && s.ahead === 0;

/** Single-glyph clone state, shared by the dashboard and the menu/picker so a clone always reads the
 *  same: ● uncommitted · ↑ clean but unpushed/local-only · ✓ clean & pushed (safe to remove). */
const statusTag = (s: CloneStatus): string => (s.dirty ? paint.yellow("●") : isSafeToClean(s) ? paint.green("✓") : paint.yellow("↑"));

/** One-line clone label for the menu and the finish/rm picker: name, branch, state tag. */
function cloneLabel(c: Clone): string {
	const s = cloneStatus(c.dir);
	return `${c.name}  ${paint.cyan(s.branch)} ${statusTag(s)}`;
}

/** True if the clone has committed work that lives only in the clone (not on a remote, not yet in the origin). */
function hasUnpreservedCommits(originRepo: string, cloneDir: string, s: CloneStatus): boolean {
	if (s.hasUpstream && s.ahead === 0) return false; // already on a remote
	const head = git(cloneDir, ["rev-parse", "HEAD"]).out;
	if (!head) return false;
	return !git(originRepo, ["cat-file", "-e", `${head}^{commit}`]).ok;
}

// ── interactive picker (TUI-lite, arrow keys, no deps) ───────────────────────
/** Returns the chosen index, or -1 when cancelled / non-interactive. */
function select(title: string, labels: string[]): Promise<number> {
	// `settle` (not `resolve`) avoids shadowing the imported path.resolve.
	return new Promise((settle) => {
		if (!process.stdin.isTTY || labels.length === 0) return settle(-1);
		let idx = 0;
		const n = labels.length;
		const out = process.stderr;
		readline.emitKeypressEvents(process.stdin);
		process.stdin.setRawMode(true);
		process.stdin.resume();
		out.write(`${title}\n`);
		const draw = () =>
			labels.forEach((l, i) => {
				out.write(`\x1b[2K${i === idx ? paint.cyan("❯ ") : "  "}${l}\n`);
			});
		draw();
		const done = (r: number) => {
			process.stdin.removeListener("keypress", onKey);
			process.stdin.setRawMode(false);
			process.stdin.pause();
			out.write("\n");
			settle(r);
		};
		const onKey = (str: string | undefined, key: Key) => {
			if (key.name === "up" || str === "k") idx = (idx - 1 + n) % n;
			else if (key.name === "down" || str === "j") idx = (idx + 1) % n;
			else if (key.name === "return") return done(idx);
			else if (key.name === "escape" || str === "q" || (key.ctrl && key.name === "c")) return done(-1);
			else return;
			out.write(`\x1b[${n}A`);
			draw();
		};
		process.stdin.on("keypress", onKey);
	});
}

async function ask(prompt: string, prefill?: string): Promise<string> {
	if (!process.stdin.isTTY) return "";
	const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
	const a = await new Promise<string>((r) => {
		rl.question(prompt, (x) => {
			rl.close();
			r(x);
		});
		if (prefill) rl.write(prefill); // pre-fill an editable default: Enter accepts, or edit it
	});
	return a.trim();
}

async function confirm(msg: string): Promise<boolean> {
	if (!process.stdin.isTTY) return false;
	return /^y(es)?$/i.test(await ask(`${msg} [y/N] `));
}

/** Resolve which clone to act on: inside a clone, by name, only-one, or interactive pick. */
async function pickClone(action: string, name?: string): Promise<{ originRepo: string; clone: Clone } | null> {
	const here = repoTopLevel(process.cwd());
	const hm = here ? readMarker(here) : undefined;
	if (here && hm && !name) return { originRepo: hm.originRepo, clone: { dir: here, name: hm.name, marker: hm } };
	// If `name` resolves to a clone directory, use its marker directly — works from anywhere,
	// even outside a repo (e.g. `kage rm ../app--fix` from the parent dir).
	if (name) {
		const asPath = resolve(name);
		const pm = readMarker(asPath);
		if (pm) return { originRepo: pm.originRepo, clone: { dir: asPath, name: pm.name, marker: pm } };
	}
	const originRepo = hm ? hm.originRepo : here;
	if (!originRepo) die("not a git repository (run inside the repo or clone, or pass a path to a clone)");
	const clones = listClones(originRepo);
	if (clones.length === 0) die("no shadow clones found for this repo");
	if (name) {
		const c = clones.find((x) => x.name === name || basename(x.dir) === name);
		if (!c) die(`no clone named ${name}`);
		return { originRepo, clone: c };
	}
	const first = clones[0];
	if (first && clones.length === 1) return { originRepo, clone: first };
	const idx = await select(`Multiple clones — pick one to ${action}:`, clones.map(cloneLabel));
	const chosen = idx < 0 ? undefined : clones[idx];
	if (!chosen) return null;
	return { originRepo, clone: chosen };
}

// ── per-agent session stores: memory in on create, back out on finish ────────
/**
 * A SessionStore moves one coding agent's session memory between the origin and a clone. kage
 * syncs the *store* (keyed by working directory), so it is agnostic to which surface — CLI, IDE
 * extension, desktop app — actually wrote the sessions: they all share one store.
 */
interface SessionStore {
	id: string;
	/** Copy the origin's recent sessions into the clone so the agent can resume them there. */
	importHistory(originRepo: string, cloneDir: string): number;
	/** Merge the sessions the clone created back into the origin. Returns the count. */
	mergeBack(cloneDir: string, originRepo: string): number;
	/** Discard the clone's sessions without merging (used by `kage rm`). */
	discard(cloneDir: string): void;
	/** Does this store have any sessions for `cwd`? (status / re-enter menu) */
	hasActivity(cwd: string): boolean;
}

/**
 * The "cwd → directory" family (pi, Claude Code): each working directory gets its own session
 * directory, so a clone starts empty and the origin's history must be copied in. One algorithm,
 * parameterized at the few format-specific points where the agents differ.
 */
interface DirStoreConfig {
	id: string;
	baseDir(): string;
	encodeCwd(abs: string): string;
	/** Rewrite the cwd recorded in a session's lines, returning the new lines. */
	setCwd(lines: string[], cwd: string): string[];
	/** Per-line identity used to dedup records on merge-back (may throw on bad JSON). */
	recordId(line: string): unknown;
	/** A fresh, self-contained copy of a session under `cwd` (new identity + filename), used
	 *  when a copied-in session was resumed and extended in the clone. */
	reidentify(lines: string[], cwd: string): { filename: string; lines: string[] };
}

/**
 * The cwd→directory algorithm, shared by pi and (later) Claude Code:
 *   - importHistory: copy the origin dir's most-recent sessions into the clone dir (cwd rewritten).
 *   - mergeBack: a session the clone created comes back whole; a copied-in origin session left
 *     unchanged is skipped; a copied-in session the clone resumed and extended comes back as a
 *     NEW self-contained file, so the origin's original (and the leaf it resumes) is untouched.
 */
function dirStore(cfg: DirStoreConfig): SessionStore {
	const dirFor = (cwd: string): string => join(cfg.baseDir(), cfg.encodeCwd(cwd));
	return {
		id: cfg.id,
		importHistory(originRepo, cloneDir) {
			const srcDir = dirFor(originRepo);
			if (!existsSync(srcDir)) return 0;
			const destDir = dirFor(cloneDir);
			mkdirSync(destDir, { recursive: true });
			const recent = readdirSync(srcDir)
				.filter((f) => f.endsWith(".jsonl"))
				.map((f) => ({ f, m: statSync(join(srcDir, f)).mtimeMs }))
				.sort((a, b) => b.m - a.m)
				.slice(0, RECENT_SESSIONS);
			let n = 0;
			for (const { f } of recent) {
				const lines = readFileSync(join(srcDir, f), "utf8").split("\n");
				writeFileSync(join(destDir, f), cfg.setCwd(lines, cloneDir).join("\n"));
				n++;
			}
			return n;
		},
		mergeBack(cloneDir, originRepo) {
			const srcDir = dirFor(cloneDir);
			if (!existsSync(srcDir)) return 0;
			const destDir = dirFor(originRepo);
			mkdirSync(destDir, { recursive: true });
			let n = 0;
			for (const f of readdirSync(srcDir)) {
				if (!f.endsWith(".jsonl")) continue;
				const src = readFileSync(join(srcDir, f), "utf8")
					.split("\n")
					.filter((l) => l.trim());
				if (src.length === 0) continue;
				const dest = join(destDir, f);

				// A session the clone created (not present in the origin) -> copy it back whole.
				if (!existsSync(dest)) {
					writeFileSync(dest, `${cfg.setCwd(src, originRepo).join("\n")}\n`);
					n++;
					continue;
				}

				// A copied-in origin session: write back only if the clone added records, and then as
				// a NEW, self-contained file so the origin's original (and the leaf it resumes) is never
				// mutated. An unchanged copy adds nothing.
				const have = new Set<unknown>();
				for (const l of readFileSync(dest, "utf8").split("\n")) {
					if (!l.trim()) continue;
					try {
						have.add(cfg.recordId(l));
					} catch {
						/* ignore */
					}
				}
				const hasNew = src.slice(1).some((l) => {
					try {
						return !have.has(cfg.recordId(l));
					} catch {
						return false;
					}
				});
				if (!hasNew) continue;
				const fresh = cfg.reidentify(src, originRepo);
				writeFileSync(join(destDir, fresh.filename), `${fresh.lines.join("\n")}\n`);
				n++;
			}
			try {
				rmSync(srcDir, { recursive: true, force: true });
			} catch (e) {
				info(paint.dim(`   (couldn't clear the clone's ${cfg.id} sessions at ${srcDir}: ${(e as Error).message})`));
			}
			return n;
		},
		discard(cloneDir) {
			const d = dirFor(cloneDir);
			try {
				rmSync(d, { recursive: true, force: true });
			} catch (e) {
				info(paint.dim(`   (couldn't discard the clone's ${cfg.id} sessions at ${d}: ${(e as Error).message})`));
			}
		},
		hasActivity(cwd) {
			const d = dirFor(cwd);
			try {
				return existsSync(d) && readdirSync(d).some((f) => f.endsWith(".jsonl"));
			} catch {
				return false;
			}
		},
	};
}

/** pi: one session per .jsonl, cwd in a first-line header, per-line `id` for dedup. */
const piStore = dirStore({
	id: "pi",
	baseDir: () => join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "sessions"),
	encodeCwd: (abs) => `--${abs.replace(/^\//, "").replace(/\//g, "-")}--`,
	setCwd(lines, cwd) {
		const out = [...lines];
		try {
			const header = JSON.parse(out[0] ?? "") as SessionHeader;
			header.cwd = cwd;
			out[0] = JSON.stringify(header);
		} catch {
			/* leave a malformed header as-is rather than drop the session */
		}
		return out;
	},
	recordId: (line) => (JSON.parse(line) as SessionHeader).id,
	reidentify(lines, cwd) {
		let header: SessionHeader = {};
		try {
			header = JSON.parse(lines[0] ?? "") as SessionHeader;
		} catch {
			/* synthesize a minimal header below */
		}
		const id = randomUUID();
		const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`;
		return { filename, lines: [JSON.stringify({ ...header, id, cwd }), ...lines.slice(1)] };
	},
});

/** Apply a JSON transform to every parseable line, leaving blank/malformed lines untouched. */
function mapJsonLines(lines: string[], fn: (rec: Record<string, unknown>) => void): string[] {
	return lines.map((l) => {
		if (!l.trim()) return l;
		try {
			const rec = JSON.parse(l) as Record<string, unknown>;
			fn(rec);
			return JSON.stringify(rec);
		} catch {
			return l;
		}
	});
}

/** Claude Code: one session per <sessionId>.jsonl, with cwd + sessionId repeated on every line. */
const claudeStore = dirStore({
	id: "claude",
	baseDir: () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects"),
	encodeCwd: (abs) => abs.replace(/[^A-Za-z0-9]/g, "-"),
	setCwd: (lines, cwd) =>
		mapJsonLines(lines, (r) => {
			if ("cwd" in r) r.cwd = cwd;
		}),
	recordId: (line) => (JSON.parse(line) as { uuid?: string }).uuid,
	reidentify(lines, cwd) {
		const id = randomUUID();
		const out = mapJsonLines(lines, (r) => {
			if ("sessionId" in r) r.sessionId = id;
			if ("cwd" in r) r.cwd = cwd;
		});
		return { filename: `${id}.jsonl`, lines: out };
	},
});

// ── Codex: global store, deliberately NOT kage-managed (see codexStore for why) ──
/** First line of a Codex rollout: { type:"session_meta", payload:{ cwd, ... } }. */
interface CodexMeta {
	payload?: { cwd?: string };
}
const codexSessionsDir = (): string => join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");

/**
 * Read just the first line of a (possibly large) file, without loading the whole thing.
 * Accumulates raw bytes and decodes once at the end — decoding each read as UTF-8 would corrupt
 * any multibyte char split across an 8 KiB read boundary (real Codex session_meta lines are tens
 * of KiB of mixed-script text).
 */
function readFirstLine(file: string): string {
	const fd = openSync(file, "r");
	try {
		const buf = Buffer.alloc(8192);
		const chunks: Buffer[] = [];
		for (;;) {
			const bytes = readSync(fd, buf, 0, buf.length, null);
			if (bytes <= 0) break;
			const nl = buf.subarray(0, bytes).indexOf(0x0a); // newline byte
			if (nl >= 0) {
				chunks.push(Buffer.from(buf.subarray(0, nl)));
				break;
			}
			chunks.push(Buffer.from(buf.subarray(0, bytes)));
		}
		return Buffer.concat(chunks).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

/** Every rollout-*.jsonl under the Codex sessions tree, paired with its session_meta cwd. */
function codexRollouts(): { file: string; cwd: string | undefined }[] {
	const base = codexSessionsDir();
	if (!existsSync(base)) return [];
	const out: { file: string; cwd: string | undefined }[] = [];
	const walk = (dir: string): void => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) {
				let cwd: string | undefined;
				try {
					cwd = (JSON.parse(readFirstLine(p)) as CodexMeta).payload?.cwd;
				} catch {
					/* not a session_meta we understand */
				}
				out.push({ file: p, cwd });
			}
		}
	};
	walk(base);
	return out;
}

/**
 * Codex keeps every session in one global tree shared by all cwds, and (since 0.13x) keys its
 * cwd-filtered resume picker off a *versioned internal sqlite index* (e.g. state_5.sqlite's
 * `threads.cwd`), not the rollout. kage can't re-home a clone's sessions to the origin without
 * rewriting that sqlite — fragile (the schema/db version moves between Codex releases) and a
 * runtime dependency kage avoids. So kage does NOT manage Codex memory: `--agent codex` gives the
 * isolated clone + git flow-back, and Codex history stays globally available via
 * `codex resume --all`. import/mergeBack/discard are intentional no-ops; hasActivity (a rollout
 * scan, never the sqlite) only powers the re-enter menu while a clone still exists.
 */
const codexStore: SessionStore = {
	id: "codex",
	importHistory: () => 0,
	mergeBack: () => 0,
	discard: () => {},
	hasActivity(cwd) {
		return codexRollouts().some((r) => r.cwd === cwd);
	},
};

// A CLI can't cd its parent shell. If the shell wrapper is active (KAGE_CD_FILE, set by
// `eval "$(kage shell-init)"`), hand it a path to cd into once kage exits; otherwise we can only
// print a copy-pasteable `cd`. armCd does the handoff; leaveClone/cdIntoClone do the messaging.
function armCd(dir: string): boolean {
	const f = process.env.KAGE_CD_FILE;
	if (!f) return false;
	try {
		writeFileSync(f, dir);
		return true;
	} catch {
		return false;
	}
}

const SHELL_INIT_HINT = `add  eval "$(kage shell-init)"  to your ~/.zshrc`;

/** After deleting the clone we were inside, the parent shell sits in a now-deleted dir — send it
 *  back to the origin (or print how, without the wrapper). */
function leaveClone(originRepo: string): void {
	if (armCd(originRepo)) {
		info(paint.dim(`   ↩  back to ${originRepo}`));
		return;
	}
	info(paint.yellow(`   ↩  your shell is still in the deleted clone — run:  ${paint.bold(`cd ${originRepo}`)}`));
	info(paint.dim(`      enable auto cd-back: ${SHELL_INIT_HINT}`));
}

/** Settle the shell inside a clone we just created/entered: cd there if the wrapper is active,
 *  else print a copy-pasteable `cd` + the finish hint. */
function cdIntoClone(cloneDir: string, name: string): void {
	info("");
	if (armCd(cloneDir)) {
		info(paint.dim(`   ↪  now in the clone — when done: ${paint.bold("kage finish")}`));
		return;
	}
	info(`   ▸  enter it:  ${paint.bold(`cd ${cloneDir}`)}`);
	info(paint.dim(`      when done: ${paint.bold(`kage finish ${name}`)}`));
	info(paint.dim(`      tip: ${SHELL_INIT_HINT} — then kage cd's you in & out automatically`));
}

/** chdir the kage process out of a clone it's about to delete (rmSync of the cwd fails otherwise).
 *  Surfaced rather than swallowed — a silent failure here is why a later rmSync would fail. */
function chdirToOrigin(originRepo: string): void {
	try {
		process.chdir(originRepo);
	} catch (e) {
		info(paint.dim(`   (couldn't chdir to ${originRepo}: ${(e as Error).message})`));
	}
}

// ── agent registry + launch (the detachable A) ─────────────────────────
/** A spawnable terminal CLI for an agent. GUI-only agents have none — use --open. */
interface AgentCli {
	bin: string;
	freshArgs: string[];
	resumeArgs: string[];
}
/** An agent = its memory store (always) + an optional spawnable CLI. */
interface Agent {
	id: string;
	store: SessionStore;
	cli?: AgentCli;
}
// Registered agents. Memory sync iterates this list, so each new agent is one entry (+ its
// SessionStore) with no change to any call site. Codex is the odd one — a flat, cwd-in-content
// store that kage doesn't memory-manage (see codexStore).
const AGENTS: Agent[] = [
	{ id: "pi", store: piStore, cli: { bin: "pi", freshArgs: [], resumeArgs: ["-c"] } },
	{ id: "claude", store: claudeStore, cli: { bin: "claude", freshArgs: [], resumeArgs: ["--continue"] } },
	{ id: "codex", store: codexStore, cli: { bin: "codex", freshArgs: [], resumeArgs: ["resume", "--last"] } },
];
const agentById = (id: string): Agent | undefined => AGENTS.find((a) => a.id === id);

function launchCli(cli: AgentCli, cwd: string, args: string[]): void {
	const r = spawnSync(cli.bin, args, { cwd, stdio: "inherit" });
	if (r.error) {
		const err = r.error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") die(`${cli.bin} not found (make sure it is installed and on your PATH)`);
		die(`failed to launch ${cli.bin}: ${err.message}`);
	}
}

/** Open the clone with an external command (e.g. `code <clone>`) and return immediately. */
function launchOpen(cmd: string, cwd: string): void {
	const parts = cmd.split(/\s+/).filter(Boolean);
	const bin = parts[0];
	if (!bin) die("--open needs a command, e.g. --open code");
	const r = spawnSync(bin, [...parts.slice(1), cwd], { stdio: "inherit" });
	if (r.error) {
		const err = r.error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") die(`${bin} not found (make sure it is installed and on your PATH)`);
		die(`failed to run --open ${cmd}: ${err.message}`);
	}
}

/** Re-enter a clone from the menu: resume an agent that has activity here (ask if several), then
 *  leave the shell in the clone. With no activity — or if you cancel the resume picker — just cd in;
 *  kage never auto-launches an agent, and Enter always lands you in the clone. */
async function enterClone(cloneDir: string, name: string): Promise<void> {
	const active = AGENTS.filter((a) => a.cli && a.store.hasActivity(cloneDir));
	let chosen = active[0]; // undefined when nothing has activity here
	if (active.length > 1) {
		const idx = await select(
			"Resume which agent? (Esc = just cd in)",
			active.map((a) => a.id),
		);
		chosen = idx < 0 ? undefined : active[idx]; // cancel → don't resume, but still cd in below
	}
	if (chosen?.cli) launchCli(chosen.cli, cloneDir, chosen.cli.resumeArgs);
	cdIntoClone(cloneDir, name);
}

// ── subcommands ───────────────────────────────────────────────────────────────
async function cmdNew(argv: string[]): Promise<void> {
	const { positional, flags } = parseArgs(argv);
	const path = positional[0];

	// Interactive launcher: `kage` with no args, inside a repo that already has clones.
	if (!path && !boolFlag(flags, "name") && process.stdin.isTTY) {
		const repoRoot = repoTopLevel(process.cwd());
		const clones = repoRoot ? listClones(repoRoot) : [];
		if (repoRoot && clones.length > 0) {
			const labels = ["＋ Create a new clone", ...clones.map(cloneLabel)];
			const idx = await select(`Shadow clones of ${basename(repoRoot)} — pick one to act on, or create:`, labels);
			if (idx < 0) return info("cancelled");
			if (idx > 0) {
				const clone = clones[idx - 1];
				if (!clone) return info("cancelled");
				const act = await select(`${clone.name}:`, [
					"Enter (resume agent + cd in)",
					"Finish (merge memory & remove)",
					"Remove (discard, no merge)",
					"Cancel",
				]);
				if (act === 0) return enterClone(clone.dir, clone.name);
				if (act === 1) return cmdFinish([clone.name]);
				if (act === 2) return cmdRm([clone.name]);
				return info("cancelled");
			}
			// idx === 0: "create" — fall through to the name prompt below.
		}
	}

	const targetPath = path ? resolve(path) : process.cwd();

	const repoRoot = repoTopLevel(targetPath);
	if (!repoRoot) die(`not a git repository: ${targetPath}`);
	if (existsSync(join(repoRoot, MARKER))) die("already inside a clone; run kage from the origin repo");

	// Resolve the clone name: explicit --name wins; otherwise show the full folder name with
	// the fixed "<repo>--" prefix in the prompt and an editable default suffix — press Enter to
	// accept, or edit the suffix (non-interactive falls back to the default).
	let name = strFlag(flags, "name") ?? "";
	if (!name) {
		const taken = (n: string) => existsSync(join(dirname(repoRoot), `${basename(repoRoot)}--${slug(n)}`));
		const def = autoName(taken);
		const prompt = `Clone name: ${basename(repoRoot)}--`;
		name = (process.stdin.isTTY ? await ask(prompt, def) : "") || def;
	}
	const safe = slug(name);
	const cloneDir = join(dirname(repoRoot), `${basename(repoRoot)}--${safe}`);
	if (existsSync(cloneDir)) die(`directory already exists: ${cloneDir}`);

	// Launch is opt-in: a CLI launches only if you named one (--agent / $KAGE_AGENT / `kage config agent`).
	// Resolve it up front so a typo fails before we copy; with none set, kage just cd's you in (below).
	const agentId = strFlag(flags, "agent") ?? process.env.KAGE_AGENT ?? readConfig().agent;
	const agent = agentId ? agentById(agentId) : undefined;
	if (agentId && !agent) die(`unknown agent: ${agentId} (supported: ${AGENTS.map((a) => a.id).join(", ")})`);

	const cp = await copyRepo(repoRoot, cloneDir);
	if (!cp.ok) die(`copy failed: ${cp.err}`);

	// kage does NOT create a branch — the clone stays on the origin's current branch.
	// Set-based memory: each agent's store imports its own origin history (no-op when empty).
	let histN = 0;
	for (const a of AGENTS) histN += a.store.importHistory(repoRoot, cloneDir);
	const marker: Marker = {
		originRepo: repoRoot,
		name: safe,
		createdAt: new Date().toISOString(),
	};
	writeFileSync(join(cloneDir, MARKER), JSON.stringify(marker, null, 2));

	const curBranch = git(cloneDir, ["rev-parse", "--abbrev-ref", "HEAD"]).out || "?";
	info("");
	info(`🥷 ${paint.bold("Shadow clone ready")}: ${cloneDir}`);
	info(`   origin: ${repoRoot}   branch: ${paint.cyan(curBranch)}`);
	if (histN > 0) info(paint.dim(`   origin's ${histN} session(s) imported — resume them from inside the clone`));

	// Optionally hand off to an agent, then settle the shell in the clone (always):
	//   --open <cmd> → run it (e.g. an editor);  an agent named → spawn it (blocking);
	//   else (--no-launch, or no agent set) → launch nothing.
	const openCmd = strFlag(flags, "open");
	if (openCmd || boolFlag(flags, "open")) {
		if (!openCmd) die("--open needs a command, e.g. --open code");
		launchOpen(openCmd, cloneDir);
	} else if (agent && !boolFlag(flags, "no-launch")) {
		if (!agent.cli) die(`agent ${agent.id} has no CLI to launch — use --open <cmd> or --no-launch`);
		launchCli(agent.cli, cloneDir, agent.cli.freshArgs);
	}
	cdIntoClone(cloneDir, safe);
}

async function cmdFinish(argv: string[]): Promise<void> {
	const { positional, flags } = parseArgs(argv);
	const force = boolFlag(flags, "force");
	const pr = boolFlag(flags, "pr");
	const push = pr || boolFlag(flags, "push"); // --pr implies --push
	const picked = await pickClone("finish", positional[0]);
	if (!picked) return info("cancelled");
	const { originRepo, clone } = picked;
	const insideClone = repoTopLevel(process.cwd()) === clone.dir;

	// Optional convenience: push the branch (and open a PR) before finishing.
	if (push) {
		const s = cloneStatus(clone.dir);
		if (s.dirty) die(`${clone.name} has uncommitted changes — commit them first (kage won't auto-commit)`);
		if (!s.hasUpstream) {
			const r = git(clone.dir, ["push", "-u", "origin", s.branch]);
			if (!r.ok) die(`push failed: ${r.err}`);
			info(`⬆  pushed ${s.branch} to origin`);
		} else if (s.ahead > 0) {
			const r = git(clone.dir, ["push"]);
			if (!r.ok) die(`push failed: ${r.err}`);
			info(`⬆  pushed ${s.ahead} commit(s)`);
		}
		if (pr) {
			const existing = prInfo(clone.dir, s.branch);
			if (existing) {
				info(`🔗 PR already open: ${existing.url}`);
			} else {
				const r = sh("gh", ["pr", "create", "--fill"], { cwd: clone.dir });
				if (!r.ok) die(`gh pr create failed: ${r.err || r.out || "is gh installed & authed?"}`);
				info(`🔗 opened PR: ${r.out.split("\n").pop()}`);
			}
		}
	}

	// Decide how to preserve the clone's committed work before deleting it.
	const s = cloneStatus(clone.dir);
	const hasRemote = git(clone.dir, ["remote"]).out.trim().length > 0;

	if (!force) {
		if (s.dirty) die(`${clone.name}: uncommitted changes — commit them, or pass --force to discard them`);
		// With a remote, keep the "push your work" guard so PR-flow mistakes surface.
		if (hasRemote && (!s.hasUpstream || s.ahead > 0)) {
			die(`${clone.name}: branch not pushed — push it (or use --push / --pr), or pass --force`);
		}
	}

	// Preserve committed work that isn't on a remote: fetch the clone's branch into the origin
	// as a local 'kage/<name>' branch (origin's working tree is left untouched). This is what
	// makes finish lossless without GitHub — the commits land in the origin's git, ready to merge.
	if (hasUnpreservedCommits(originRepo, clone.dir, s)) {
		const head = git(clone.dir, ["rev-parse", "HEAD"]).out;
		// Always a unique ref (name + short sha) so reusing a clone name never collides with an
		// earlier preserved branch — which would either abort the fetch (non-ff) or clobber it.
		const target = `kage/${slug(clone.name)}-${head.slice(0, 7)}`;
		const r = git(originRepo, ["fetch", clone.dir, `${s.branch}:refs/heads/${target}`]);
		if (!r.ok) die(`failed to preserve the clone's branch into the origin: ${r.err}`);
		info(`🌿 preserved the clone's commits in the origin as ${paint.cyan(target)}  (merge with: git merge ${target})`);
	}

	let n = 0;
	for (const a of AGENTS) n += a.store.mergeBack(clone.dir, originRepo);
	chdirToOrigin(originRepo);
	rmSync(clone.dir, { recursive: true, force: true });

	info(`💨 Clone dispelled: merged ${n} session(s) back, removed ${clone.dir}`);
	if (insideClone) leaveClone(originRepo);
}

async function cmdRm(argv: string[]): Promise<void> {
	const { positional, flags } = parseArgs(argv);
	const force = boolFlag(flags, "force");
	const picked = await pickClone("remove", positional[0]);
	if (!picked) return info("cancelled");
	const { originRepo, clone } = picked;
	const insideClone = repoTopLevel(process.cwd()) === clone.dir;

	if (!force) {
		const s = cloneStatus(clone.dir);
		if (s.dirty || hasUnpreservedCommits(originRepo, clone.dir, s)) {
			die(`${clone.name} has local-only work — use 'kage finish' to keep it, or 'kage rm --force' to discard`);
		}
		if (!(await confirm(`Discard clone ${clone.name} without merging its memory?`))) return info("aborted");
	}

	chdirToOrigin(originRepo);
	for (const a of AGENTS) a.store.discard(clone.dir);
	rmSync(clone.dir, { recursive: true, force: true });
	info(`🗑  Removed clone ${clone.name} (${clone.dir})`);
	if (insideClone) leaveClone(originRepo);
}

function cmdList(argv: string[]): void {
	const { flags } = parseArgs(argv);
	const here = repoTopLevel(process.cwd());
	if (!here) die("not a git repository");
	// Works from inside a clone too: resolve to the origin via the marker, then list its clones.
	const repoRoot = readMarker(here)?.originRepo || here;
	const clones = listClones(repoRoot);
	if (clones.length === 0) {
		info("No shadow clones.");
		return;
	}

	info(paint.bold(`Shadow clones of ${basename(repoRoot)}:`));
	info("");
	for (const c of clones) {
		const s = cloneStatus(c.dir);
		const pr = boolFlag(flags, "pr") ? prInfo(c.dir, s.branch) : undefined;

		// header: status glyph · name · branch · age
		const glyph = statusTag(s);
		const age = paint.dim(`created ${ago(c.marker.createdAt)}`);
		info(`  ${glyph} ${paint.bold(c.name)}  ${paint.cyan(s.branch)}  ${age}`);

		// detail: working-tree state · sync · PR · safe-to-clean
		const parts: string[] = [];
		if (s.dirty) {
			let d = `${s.dirtyCount} changed`;
			if (s.added || s.removed) d += ` (${paint.green(`+${s.added}`)} ${paint.red(`-${s.removed}`)})`;
			parts.push(paint.yellow(d));
		} else {
			parts.push(paint.green("clean"));
		}
		if (!s.hasUpstream) parts.push(paint.dim("not pushed"));
		else {
			const sync: string[] = [];
			if (s.ahead) sync.push(`↑${s.ahead}`);
			if (s.behind) sync.push(`↓${s.behind}`);
			parts.push(sync.length ? sync.join(" ") : paint.dim("in sync"));
		}
		if (pr) parts.push(prState(pr));
		if (isSafeToClean(s)) parts.push(paint.green("safe to clean"));
		info(`      ${parts.join(paint.dim("  ·  "))}`);

		// last commit on the branch
		if (s.lastCommit) {
			info(paint.dim(`      last: ${s.lastCommit.sha} "${s.lastCommit.subject}" (${s.lastCommit.when})`));
		}
		info("");
	}
	info(paint.dim("  finish <name> to merge & remove · rm <name> to discard · status --pr for PR status"));
}

const PR_COLORS: Record<string, Paint> = { OPEN: paint.green, MERGED: paint.magenta, CLOSED: paint.red };
function prState(pr: Pr): string {
	const f = PR_COLORS[pr.state] ?? paint.dim;
	return f(`PR #${pr.number} ${pr.state.toLowerCase()}`);
}

function cmdPull(argv: string[]): void {
	const { positional } = parseArgs(argv);
	const cloneDir = repoTopLevel(process.cwd());
	const marker = cloneDir ? readMarker(cloneDir) : undefined;
	if (!cloneDir || !marker) die("kage pull only runs inside a clone (edit the origin directly otherwise)");
	if (positional.length === 0) die("usage: kage pull <relative-path> [more paths...]");
	const originRepo = marker.originRepo;
	const cloneRoot = cloneDir.endsWith(sep) ? cloneDir : cloneDir + sep;
	const originRoot = originRepo.endsWith(sep) ? originRepo : originRepo + sep;
	let done = 0;
	for (const rel of positional) {
		const src = resolve(cloneDir, rel);
		const dst = resolve(originRepo, rel);
		if (!src.startsWith(cloneRoot) || !dst.startsWith(originRoot)) {
			info(`✗ path escapes the repo, skipped: ${rel}`);
			continue;
		}
		if (!existsSync(src)) {
			info(`✗ not found in clone, skipped: ${rel}`);
			continue;
		}
		if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
		mkdirSync(dirname(dst), { recursive: true });
		const cp = copyTree(src, dst);
		if (!cp.ok) {
			info(`✗ copy failed ${rel}: ${cp.err}`);
			continue;
		}
		done++;
	}
	info(`📤 Pulled ${done}/${positional.length} path(s) from the clone back to the origin (${originRepo})`);
}

/** get/set kage's small persisted config (~/.config/kage/config.json). Keys are validated so a
 *  typo can't silently become a "default". `kage config` (no args) prints the file path + every key. */
function cmdConfig(argv: string[]): void {
	const { positional, flags } = parseArgs(argv);
	const cfg = readConfig();
	const key = positional[0] ?? (typeof flags.unset === "string" ? flags.unset : undefined);
	const value = positional[1];

	if (!key) {
		info(paint.dim(`# ${configPath()}`));
		for (const k of CONFIG_KEYS) info(`${k} = ${cfg[k] ?? paint.dim("(unset)")}`);
		return;
	}
	if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
		die(`unknown config key: ${key} (known: ${CONFIG_KEYS.join(", ")})`);
	}
	const k = key as ConfigKey;

	if (boolFlag(flags, "unset")) {
		delete cfg[k];
		writeConfig(cfg);
		info(`unset ${k}`);
		return;
	}
	if (value === undefined) {
		// a bare read goes to stdout so `X=$(kage config <key>)` works; other output stays on stderr
		process.stdout.write(`${cfg[k] ?? ""}\n`);
		return;
	}

	if (k === "agent" && !agentById(value)) {
		die(`unknown agent: ${value} (supported: ${AGENTS.map((a) => a.id).join(", ")})`);
	}
	cfg[k] = value;
	writeConfig(cfg);
	info(`${k} = ${value}`);
}

const SHELL_INIT = `# kage shell integration — add to ~/.zshrc or ~/.bashrc:  eval "$(kage shell-init)"
kage() {
  local f; f="$(mktemp "\${TMPDIR:-/tmp}/kage-cd.XXXXXX")"
  KAGE_CD_FILE="$f" command kage "$@"; local rc=$?
  if [ -s "$f" ]; then cd "$(cat "$f")"; fi
  rm -f "$f"
  return $rc
}
if [ -n "$ZSH_VERSION" ]; then
  _kage() {
    if (( CURRENT == 2 )); then compadd new status finish rm pull config; return; fi
    case "\${words[2]}" in
      finish|rm) compadd $(command kage __clones 2>/dev/null);;
      config) compadd agent;;
    esac
  }
  compdef _kage kage
elif [ -n "$BASH_VERSION" ]; then
  _kage() {
    local cur="\${COMP_WORDS[COMP_CWORD]}"
    if [ "$COMP_CWORD" -eq 1 ]; then COMPREPLY=( $(compgen -W "new status finish rm pull config" -- "$cur") ); return; fi
    case "\${COMP_WORDS[1]}" in
      finish|rm) COMPREPLY=( $(compgen -W "$(command kage __clones 2>/dev/null)" -- "$cur") );;
      config) COMPREPLY=( $(compgen -W "agent" -- "$cur") );;
    esac
  }
  complete -F _kage kage
fi`;

function cmdClones(): void {
	const repoRoot = repoTopLevel(process.cwd());
	if (!repoRoot) return;
	for (const c of listClones(repoRoot)) process.stdout.write(`${c.name}\n`);
}

const HELP = `kage 🥷 — Shadow Clone Jutsu for your git repo

Usage:
  kage [path] [--name <x>] [--agent <id>]              clone the repo and cd into it (launch an agent only if one is set)
                                                       --open <cmd> opens it elsewhere; --no-launch skips the agent
                                                       (no args inside a repo with clones: interactive menu)
  kage status [--pr]                                   dashboard of clones (--pr adds PR status via gh)
  kage finish [name] [--force] [--push] [--pr]         preserve work -> merge memory back -> delete clone
                                                       (--push/--pr use a remote; with no remote the branch is
                                                        kept in the origin as a local 'kage/<name>-<sha>' branch)
  kage rm [name] [--force]                             discard a clone without merging
  kage pull <path...>                                  (inside a clone) copy files back to the origin
  kage config [<key> [value]] [--unset]                get/set persisted defaults (e.g. the launch agent)
  kage shell-init                                      shell wrapper (cd into clones / back) + tab completion
  kage --help | --version                              show this help / print the version

With no args inside a repo that already has clones, kage opens an interactive menu
(create a new clone, or enter / finish / remove an existing one).

Options:
  --name <x>    name the clone folder /<repo>--<x> (default: a generated name like swift-heron); skips the name prompt
                (sanitized to a git-ref-safe slug, since the name is also used as a branch name)
  --agent <id>  launch this agent CLI in the clone (one-off). with none set (--agent > $KAGE_AGENT >
                'kage config agent') kage just cd's you into the clone. memory syncs for every agent
  --open <cmd>  after cloning, run '<cmd> <clone>' (e.g. --open code), then cd into the clone
  --no-launch   don't launch an agent even if one is configured — just create the clone and cd in
  --pr          (finish) push the branch and open a GitHub PR via gh, then finish
  --push        (finish) push the branch before finishing (implied by --pr)
  --force       skip the safety checks: uncommitted/unpushed guard (finish) or local-only guard (rm)

Examples:
  kage                          # clone the current repo, pick a name, and cd into the clone
  kage --name fix-login         # same, but name the clone ../<repo>--fix-login (no prompt)
  kage ~/code/other-repo        # clone a different repo instead of the current dir

  kage status                   # in the origin: list your clones + their git state
  kage status --pr              # ...also show each clone's PR state (needs gh)

  # after you've worked in a clone (committed your changes), from the origin:
  kage finish fix-login         # you already pushed -> merge memory back, delete the clone
  kage finish fix-login --pr    # push the branch + open a PR via gh, then finish
  kage finish fix-login --force # finish even with uncommitted/unpushed work
  kage rm experiment            # throw a clone away without merging its memory

  kage pull .env                # inside a clone: copy a gitignored file back to the origin
  kage config agent claude      # launch claude on create (instead of just cd-ing into the clone)

Env (each agent's own native var — kage just honors it, so kage and the agent always agree):
  KAGE_AGENT            agent to launch on create when --agent is omitted (none set = just cd into the clone)
  PI_CODING_AGENT_DIR   pi's agent dir; sessions read from <it>/sessions (default: ~/.pi/agent)
  CLAUDE_CONFIG_DIR     Claude Code's config dir; sessions read from <it>/projects (default: ~/.claude)
  CODEX_HOME            Codex's home dir; sessions read from <it>/sessions (default: ~/.codex)`;

async function main(): Promise<void> {
	const [sub, ...rest] = process.argv.slice(2);
	switch (sub) {
		case undefined:
		case "new":
			return cmdNew(sub === "new" ? rest : process.argv.slice(2));
		case "status":
			return cmdList(rest);
		case "finish":
			return cmdFinish(rest);
		case "rm":
			return cmdRm(rest);
		case "pull":
			return cmdPull(rest);
		case "config":
			return cmdConfig(rest);
		case "shell-init": {
			process.stdout.write(`${SHELL_INIT}\n`);
			// When a human runs this directly (stdout is a TTY, not captured by `$(...)`),
			// the script just scrolled past unused — show how to actually activate it.
			// During `eval "$(kage shell-init)"` stdout is a pipe, so this stays silent.
			if (process.stdout.isTTY) {
				info("");
				info(paint.dim("# ↑ the script above isn't run by printing it — activate it with:"));
				info(`  eval "$(kage shell-init)"   ${paint.dim("# add this line to your ~/.zshrc or ~/.bashrc")}`);
			}
			return;
		}
		case "__clones":
			return cmdClones();
		case "-h":
		case "--help":
			return info(HELP);
		case "-v":
		case "--version":
			return info(VERSION);
		default:
			// `kage <path>` clones another repo, but a bare word that isn't an existing directory
			// is a mistyped command (e.g. `kage statsu`) — fail clearly instead of "not a git repository".
			if (!sub.startsWith("-") && !(existsSync(resolve(sub)) && statSync(resolve(sub)).isDirectory())) {
				die(`unknown command or path: ${sub}  (run 'kage --help')`);
			}
			return cmdNew(process.argv.slice(2)); // `kage <path>` or `kage <flags>`
	}
}

main();
