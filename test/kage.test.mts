import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

// Resolved from the compiled test (dist/kage.test.mjs), so "../bin" and "../package.json"
// point at the project root — the build emits tests to dist/ for exactly this reason.
const CLI = new URL("../bin/kage.mjs", import.meta.url).pathname;

interface RunOpts {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

function run(args: string[], opts: RunOpts = {}): SpawnSyncReturns<string> {
	// Keep every agent's store inside the test's temp dir (next to pi's agent dir), so a test
	// never reads or writes the real ~/.codex or ~/.claude. Explicit values in opts.env win.
	const env = opts.env;
	if (env?.PI_CODING_AGENT_DIR) {
		// Pin every agent store + kage's own config under the test's temp home. Force (not ??=): a value
		// the runner exports — GitHub's Linux runners export XDG_CONFIG_HOME — would otherwise survive the
		// `...process.env` spread and let one test's `kage config` leak into the next (e.g. agent=claude).
		const home = dirname(env.PI_CODING_AGENT_DIR);
		env.CODEX_HOME = join(home, "codex");
		env.CLAUDE_CONFIG_DIR = join(home, "claude");
		env.XDG_CONFIG_HOME = join(home, "config");
	}
	return spawnSync("node", [CLI, ...args], { encoding: "utf8", ...opts });
}

function tmp(): string {
	return mkdtempSync(join(tmpdir(), "kage-test-"));
}

function initRepo(dir: string): void {
	spawnSync("git", ["init", "-q"], { cwd: dir });
	spawnSync("git", ["config", "user.email", "t@t.co"], { cwd: dir });
	spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
	writeFileSync(join(dir, "a.txt"), "hi\n");
	spawnSync("git", ["add", "."], { cwd: dir });
	spawnSync("git", ["commit", "-qm", "init"], { cwd: dir });
}

/** A PATH containing a fake `pi` that exits immediately, so `kage new` can run headless. */
function fakePiPath(root: string): string {
	const bin = join(root, "bin");
	mkdirSync(bin, { recursive: true });
	const pi = join(bin, "pi");
	writeFileSync(pi, "#!/bin/sh\nexit 0\n");
	chmodSync(pi, 0o755);
	return `${bin}:${process.env.PATH}`;
}

/** Add another no-op fake binary (e.g. `claude`) into the fake-bin dir created by fakePiPath. */
function addFakeBin(root: string, name: string): void {
	const p = join(root, "bin", name);
	writeFileSync(p, "#!/bin/sh\nexit 0\n");
	chmodSync(p, 0o755);
}

/** Drop a fake `gh` into the fake-bin dir (already on PATH via fakePiPath) that echoes fixed JSON. */
function fakeGh(root: string, json: string): void {
	const gh = join(root, "bin", "gh");
	writeFileSync(gh, `#!/bin/sh\ncat <<'JSON'\n${json}\nJSON\n`);
	chmodSync(gh, 0o755);
}

const enc = (abs: string): string => `--${abs.replace(/^\//, "").replace(/\//g, "-")}--`;
const encClaude = (abs: string): string => abs.replace(/[^A-Za-z0-9]/g, "-");

test("--help prints usage", () => {
	const r = run(["--help"]);
	assert.equal(r.status, 0);
	assert.match(r.stderr, /Shadow Clone Jutsu/);
	assert.match(r.stderr, /kage finish/);
});

test("--version prints the package version and stays in sync", () => {
	const r = run(["--version"]);
	assert.equal(r.status, 0);
	assert.match(r.stderr, /\d+\.\d+\.\d+/);
	// the embedded VERSION constant must match package.json (single-file installs have no package.json)
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(r.stderr.trim(), pkg.version);
});

test("errors outside a git repo", () => {
	const d = tmp();
	try {
		const r = run(["status"], { cwd: d });
		assert.equal(r.status, 1);
		assert.match(r.stderr, /not a git repository/);
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
});

test("status reports no clones in a fresh repo", () => {
	const root = tmp();
	const repo = join(root, "repo");
	mkdirSync(repo);
	initRepo(repo);
	try {
		const r = run(["status"], { cwd: repo });
		assert.equal(r.status, 0);
		assert.match(r.stderr, /No shadow clones/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("new creates a clone, list shows it, finish removes it", () => {
	const root = tmp();
	const repo = join(root, "repo");
	mkdirSync(repo);
	initRepo(repo);
	const env = { ...process.env, PATH: fakePiPath(root), PI_CODING_AGENT_DIR: join(root, "pi") };
	const clone = join(root, "repo--t1");
	try {
		const r = run(["--name", "t1"], { cwd: repo, env });
		assert.equal(r.status, 0);
		assert.ok(existsSync(clone), "clone dir should exist");
		assert.ok(existsSync(join(clone, ".kage.json")), "marker should exist");
		assert.ok(existsSync(join(clone, "a.txt")), "files should be copied");

		const list = run(["status"], { cwd: repo, env });
		assert.match(list.stderr, /Shadow clones of repo/);
		assert.match(list.stderr, /t1/);
		assert.match(list.stderr, /not pushed/); // status dashboard column

		// status also works from INSIDE the clone (resolves the origin via the marker)
		const inside = run(["status"], { cwd: clone, env });
		assert.match(inside.stderr, /Shadow clones of repo/);
		assert.match(inside.stderr, /t1/);

		// nothing committed/pushed in the clone -> needs --force
		const finish = run(["finish", "t1", "--force"], { cwd: repo, env });
		assert.equal(finish.status, 0);
		assert.ok(!existsSync(clone), "clone dir should be removed");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("--name=value (equals form) is parsed and names the clone folder", () => {
	const root = tmp();
	const repo = join(root, "repo");
	mkdirSync(repo);
	initRepo(repo);
	const env = { ...process.env, PATH: fakePiPath(root), PI_CODING_AGENT_DIR: join(root, "pi") };
	const clone = join(root, "repo--eqname");
	try {
		const r = run(["--name=eqname"], { cwd: repo, env });
		assert.equal(r.status, 0, r.stderr);
		assert.ok(existsSync(clone), "the `--name=eqname` equals-form should name the folder repo--eqname");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("status --pr surfaces PR state via gh", () => {
	const root = tmp();
	const repo = join(root, "repo");
	mkdirSync(repo);
	initRepo(repo);
	const env = { ...process.env, PATH: fakePiPath(root), PI_CODING_AGENT_DIR: join(root, "pi") };
	fakeGh(root, '{"state":"OPEN","number":7,"url":"https://example.com/pr/7"}');
	try {
		run(["--name", "prtest"], { cwd: repo, env });
		const r = run(["status", "--pr"], { cwd: repo, env });
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stderr, /PR #7 open/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("status --pr ignores gh output that isn't a valid PR shape (isPr rejects, no crash)", () => {
	const root = tmp();
	const repo = join(root, "repo");
	mkdirSync(repo);
	initRepo(repo);
	const env = { ...process.env, PATH: fakePiPath(root), PI_CODING_AGENT_DIR: join(root, "pi") };
	fakeGh(root, '{"unexpected":"shape"}'); // valid JSON, wrong shape -> isPr() must reject it
	try {
		run(["--name", "prbad"], { cwd: repo, env });
		const r = run(["status", "--pr"], { cwd: repo, env });
		assert.equal(r.status, 0, r.stderr); // dashboard still renders
		assert.doesNotMatch(r.stderr, /PR #/); // ...just without a PR line
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("shell-init prints a cd wrapper and completion", () => {
	const r = run(["shell-init"]);
	assert.equal(r.status, 0);
	assert.match(r.stdout, /KAGE_CD_FILE/);
	assert.match(r.stdout, /compdef _kage kage|complete -F _kage kage/);
});

test("origin history is copied into the clone, and new clone work merges back without duplicating it", () => {
	const root = tmp();
	const repo = join(root, "repo");
	mkdirSync(repo);
	initRepo(repo);
	const sessions = join(root, "pi", "sessions");
	const env = { ...process.env, PATH: fakePiPath(root), PI_CODING_AGENT_DIR: join(root, "pi") };

	// seed the origin's session dir with one history file (encoded by the real toplevel path)
	const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, encoding: "utf8" }).stdout.trim();
	const originDir = join(sessions, enc(top));
	mkdirSync(originDir, { recursive: true });
	const histName = "2026-01-01T00-00-00-000Z_aaaaaaaa-0000-0000-0000-000000000000.jsonl";
	writeFileSync(join(originDir, histName), `${JSON.stringify({ type: "session", version: 3, id: "hist", cwd: top })}\n`);

	const clone = join(root, "repo--h1");
	try {
		run(["--name", "h1"], { cwd: repo, env });
		const h1SessName = readdirSync(sessions).find((d) => d.endsWith("repo--h1--"));
		assert.ok(h1SessName, "the clone's session dir should exist");
		const cloneSessDir = join(sessions, h1SessName);
		// the origin's history is copied into the clone (resumable there)
		assert.ok(existsSync(join(cloneSessDir, histName)), "origin history should be copied into the clone");

		// simulate new clone work: a brand-new session file the clone created
		const newName = "2026-02-02T00-00-00-000Z_bbbbbbbb-0000-0000-0000-000000000000.jsonl";
		writeFileSync(join(cloneSessDir, newName), `${JSON.stringify({ type: "session", version: 3, id: "new", cwd: clone })}\n`);

		run(["finish", "h1", "--force"], { cwd: repo, env });
		const originFiles = readdirSync(originDir);
		assert.ok(originFiles.includes(histName), "origin keeps its original history file");
		assert.ok(originFiles.includes(newName), "clone's new session merges back into the origin");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("--no-launch builds the clone and imports memory without launching the agent", () => {
	const root = tmp();
	const repo = join(root, "repo");
	mkdirSync(repo);
	initRepo(repo);
	const sessions = join(root, "pi", "sessions");
	// a fake pi that records (by touching a file) if it is ever launched
	const bin = join(root, "bin");
	mkdirSync(bin, { recursive: true });
	const launched = join(root, "launched");
	writeFileSync(join(bin, "pi"), `#!/bin/sh\ntouch "${launched}"\n`);
	chmodSync(join(bin, "pi"), 0o755);
	const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: join(root, "pi") };

	const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, encoding: "utf8" }).stdout.trim();
	const originDir = join(sessions, enc(top));
	mkdirSync(originDir, { recursive: true });
	const histName = "2026-01-01T00-00-00-000Z_dddddddd-0000-0000-0000-000000000000.jsonl";
	writeFileSync(join(originDir, histName), `${JSON.stringify({ type: "session", version: 3, id: "hist", cwd: top })}\n`);

	const clone = join(root, "repo--nl1");
	try {
		const r = run(["--name", "nl1", "--no-launch"], { cwd: repo, env });
		assert.equal(r.status, 0, r.stderr);
		assert.ok(existsSync(clone), "clone created");
		assert.ok(existsSync(join(clone, ".kage.json")), "marker written");
		assert.ok(!existsSync(launched), "the agent CLI must NOT be launched with --no-launch");
		// memory is still imported, regardless of launch mode
		const cloneSessName = readdirSync(sessions).find((d) => d.endsWith("repo--nl1--"));
		assert.ok(cloneSessName, "clone session dir exists");
		assert.ok(existsSync(join(sessions, cloneSessName, histName)), "origin history imported even with --no-launch");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("--agent rejects an unknown agent before creating anything", () => {
	const root = tmp();
	const repo = join(root, "repo");
	mkdirSync(repo);
	initRepo(repo);
	const env = { ...process.env, PATH: fakePiPath(root), PI_CODING_AGENT_DIR: join(root, "pi") };
	try {
		const r = run(["--name", "x", "--agent", "nope", "--no-launch"], { cwd: repo, env });
		assert.equal(r.status, 1);
		assert.match(r.stderr, /unknown agent: nope/);
		assert.ok(!existsSync(join(root, "repo--x")), "no clone is created when the agent is invalid");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("default (no agent named): kage cd's the shell into the new clone and launches nothing", () => {
	const root = tmp();
	const repo = join(root, "repo");
	mkdirSync(repo, { recursive: true });
	initRepo(repo);
	// fake CLIs that record if they run, so we can prove nothing was auto-launched
	const bin = join(root, "bin");
	mkdirSync(bin, { recursive: true });
	for (const name of ["pi", "claude"]) {
		writeFileSync(join(bin, name), `#!/bin/sh\ntouch "${join(root, `${name}.ran`)}"\n`);
		chmodSync(join(bin, name), 0o755);
	}
	const cdFile = join(root, "cd");
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PATH: `${bin}:${process.env.PATH}`,
		PI_CODING_AGENT_DIR: join(root, "pi"),
		KAGE_CD_FILE: cdFile, // simulate the shell wrapper being active
	};
	delete env.KAGE_AGENT;
	const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, encoding: "utf8" }).stdout.trim();
	const clone = join(dirname(top), "repo--d1");
	try {
		const r = run(["--name", "d1"], { cwd: repo, env });
		assert.equal(r.status, 0, r.stderr);
		assert.ok(existsSync(clone), "clone created");
		assert.ok(!existsSync(join(root, "pi.ran")), "no agent auto-launched (pi)");
		assert.ok(!existsSync(join(root, "claude.ran")), "no agent auto-launched (claude)");
		assert.equal(readFileSync(cdFile, "utf8"), clone, "the shell is cd'd into the new clone via KAGE_CD_FILE");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("config agent: a persisted default is used when --agent/$KAGE_AGENT are absent", () => {
	const root = tmp();
	const repo = join(root, "repo");
	mkdirSync(repo, { recursive: true });
	initRepo(repo);
	const bin = join(root, "bin");
	mkdirSync(bin, { recursive: true });
	for (const name of ["pi", "claude"]) {
		writeFileSync(join(bin, name), `#!/bin/sh\ntouch "${join(root, `${name}.ran`)}"\n`);
		chmodSync(join(bin, name), 0o755);
	}
	const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: join(root, "pi") };
	delete env.KAGE_AGENT;
	try {
		// persist claude as the default; a later clone (no flag/env) should launch it, not pi (registry order would pick pi)
		const set = run(["config", "agent", "claude"], { cwd: repo, env });
		assert.equal(set.status, 0, set.stderr);
		const r = run(["--name", "cfg"], { cwd: repo, env });
		assert.equal(r.status, 0, r.stderr);
		assert.ok(existsSync(join(root, "claude.ran")), "the persisted config agent (claude) was launched");
		assert.ok(!existsSync(join(root, "pi.ran")), "did not fall back to pi's registry-order default");
		// $KAGE_AGENT still overrides the persisted config
		const env2: NodeJS.ProcessEnv = { ...env, KAGE_AGENT: "pi" };
		run(["--name", "cfg2"], { cwd: repo, env: env2 });
		assert.ok(existsSync(join(root, "pi.ran")), "$KAGE_AGENT overrides the persisted config");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("config agent: rejects an unknown agent id (no silent junk written)", () => {
	const root = tmp();
	const repo = join(root, "repo");
	mkdirSync(repo, { recursive: true });
	initRepo(repo);
	const env = { ...process.env, PATH: fakePiPath(root), PI_CODING_AGENT_DIR: join(root, "pi") };
	try {
		const r = run(["config", "agent", "nope"], { cwd: repo, env });
		assert.equal(r.status, 1);
		assert.match(r.stderr, /unknown agent: nope/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("finish --push pushes the branch then finishes", () => {
	const root = tmp();
	spawnSync("git", ["init", "-q", "--bare", join(root, "remote.git")]);
	spawnSync("git", ["clone", "-q", join(root, "remote.git"), join(root, "repo")]);
	const repo = join(root, "repo");
	spawnSync("git", ["config", "user.email", "t@t.co"], { cwd: repo });
	spawnSync("git", ["config", "user.name", "t"], { cwd: repo });
	writeFileSync(join(repo, "a.txt"), "hi\n");
	spawnSync("git", ["add", "."], { cwd: repo });
	spawnSync("git", ["commit", "-qm", "init"], { cwd: repo });
	spawnSync("git", ["push", "-q", "-u", "origin", "HEAD"], { cwd: repo });
	const env = { ...process.env, PATH: fakePiPath(root), PI_CODING_AGENT_DIR: join(root, "pi") };
	const clone = join(root, "repo--p1");
	try {
		run(["--name", "p1"], { cwd: repo, env });
		// make a committed-but-unpushed change in the clone on a new branch
		spawnSync("git", ["switch", "-qc", "feat"], { cwd: clone });
		writeFileSync(join(clone, "b.txt"), "x\n");
		spawnSync("git", ["add", "."], { cwd: clone });
		spawnSync("git", ["commit", "-qm", "work"], { cwd: clone });

		const r = run(["finish", "p1", "--push"], { cwd: repo, env });
		assert.equal(r.status, 0, r.stderr);
		assert.ok(!existsSync(clone), "clone removed");
		// the branch should now exist on the remote
		const ls = spawnSync("git", ["ls-remote", "--heads", join(root, "remote.git"), "feat"], { encoding: "utf8" });
		assert.match(ls.stdout, /refs\/heads\/feat/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resuming a copied-in origin session and adding turns merges those turns back (not dropped)", () => {
	const root = tmp();
	const repo = join(root, "repo");
	mkdirSync(repo);
	initRepo(repo);
	const sessions = join(root, "pi", "sessions");
	const env = { ...process.env, PATH: fakePiPath(root), PI_CODING_AGENT_DIR: join(root, "pi") };

	const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, encoding: "utf8" }).stdout.trim();
	const originDir = join(sessions, enc(top));
	mkdirSync(originDir, { recursive: true });
	const histName = "2026-01-01T00-00-00-000Z_cccccccc-0000-0000-0000-000000000000.jsonl";
	const rec = (o: unknown): string => JSON.stringify(o);
	writeFileSync(
		join(originDir, histName),
		`${[
			rec({ type: "session", version: 3, id: "hist", cwd: top }),
			rec({ type: "message", id: "r1" }),
			rec({ type: "message", id: "r2" }),
		].join("\n")}\n`,
	);

	try {
		run(["--name", "r1"], { cwd: repo, env });
		const r1SessName = readdirSync(sessions).find((d) => d.endsWith("repo--r1--"));
		assert.ok(r1SessName, "the clone's session dir should exist");
		const cloneSessDir = join(sessions, r1SessName);
		// simulate resuming the copied origin session in the clone and adding a new turn
		appendFileSync(join(cloneSessDir, histName), `${rec({ type: "message", id: "r3" })}\n`);

		run(["finish", "r1", "--force"], { cwd: repo, env });
		// the origin's original session is left untouched (leaf preserved)
		const origX = readFileSync(join(originDir, histName), "utf8")
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
		assert.deepEqual(
			origX.map((e) => e.id),
			["hist", "r1", "r2"],
			"origin's original session must not be mutated",
		);
		// the resumed continuation comes back as a NEW, self-contained session file
		const files = readdirSync(originDir).filter((f) => f.endsWith(".jsonl"));
		assert.equal(files.length, 2, "a separate session file should be added");
		const newFile = files.find((f) => f !== histName);
		assert.ok(newFile, "a separate session file should exist");
		const added = readFileSync(join(originDir, newFile), "utf8")
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
		const ids = added.map((e) => e.id);
		assert.ok(ids.includes("r3"), "the appended turn is preserved in the new session");
		assert.ok(ids.includes("r1"), "the new session is self-contained (keeps the copied prefix)");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Claude Code: origin history imports into the clone and new clone sessions merge back", () => {
	const root = tmp();
	const repo = join(root, "repo");
	mkdirSync(repo);
	initRepo(repo);
	const claudeHome = join(root, "claude");
	const PATH = fakePiPath(root);
	addFakeBin(root, "claude");
	const env = { ...process.env, PATH, PI_CODING_AGENT_DIR: join(root, "pi"), CLAUDE_CONFIG_DIR: claudeHome };
	const line = (o: unknown): string => JSON.stringify(o);

	const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, encoding: "utf8" }).stdout.trim();
	const originDir = join(claudeHome, "projects", encClaude(top));
	mkdirSync(originDir, { recursive: true });
	const sid = "11111111-1111-1111-1111-111111111111";
	writeFileSync(
		join(originDir, `${sid}.jsonl`),
		`${[
			line({ type: "user", sessionId: sid, uuid: "u1", cwd: top, message: { role: "user", content: "hi" } }),
			line({ type: "assistant", sessionId: sid, uuid: "u2", cwd: top, message: { role: "assistant", content: "yo" } }),
		].join("\n")}\n`,
	);

	const clone = join(root, "repo--c1");
	try {
		const r = run(["--name", "c1", "--agent", "claude"], { cwd: repo, env });
		assert.equal(r.status, 0, r.stderr);
		assert.ok(existsSync(clone), "clone created");

		// origin history imported into the clone's Claude project dir, with cwd rewritten to the clone
		// (find the dir rather than encode it: git resolves the /var -> /private/var symlink)
		const projects = join(claudeHome, "projects");
		const cloneDirName = readdirSync(projects).find((d) => d.endsWith("repo--c1"));
		assert.ok(cloneDirName, "the clone's Claude project dir exists");
		const cloneDir = join(projects, cloneDirName);
		assert.ok(existsSync(join(cloneDir, `${sid}.jsonl`)), "origin Claude session imported into the clone");
		const imported = readFileSync(join(cloneDir, `${sid}.jsonl`), "utf8")
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
		assert.ok(
			imported.every((e) => e.cwd !== top && encClaude(e.cwd) === cloneDirName),
			"imported lines have cwd rewritten to the clone's path",
		);

		// the clone creates a brand-new Claude session (cwd = the clone path kage actually used)
		const cloneCwd = imported[0].cwd;
		const nsid = "22222222-2222-2222-2222-222222222222";
		writeFileSync(join(cloneDir, `${nsid}.jsonl`), `${line({ type: "user", sessionId: nsid, uuid: "n1", cwd: cloneCwd })}\n`);

		run(["finish", "c1", "--force"], { cwd: repo, env });
		const files = readdirSync(originDir);
		assert.ok(files.includes(`${sid}.jsonl`), "origin keeps its original session");
		assert.ok(files.includes(`${nsid}.jsonl`), "the clone's new session merged back into the origin");
		const merged = readFileSync(join(originDir, `${nsid}.jsonl`), "utf8")
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
		assert.ok(
			merged.every((e) => e.cwd === top),
			"merged-back lines have cwd rewritten to the origin",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Claude Code: resuming a copied-in session merges new turns back as a fresh session", () => {
	const root = tmp();
	const repo = join(root, "repo");
	mkdirSync(repo);
	initRepo(repo);
	const claudeHome = join(root, "claude");
	const PATH = fakePiPath(root);
	addFakeBin(root, "claude");
	const env = { ...process.env, PATH, PI_CODING_AGENT_DIR: join(root, "pi"), CLAUDE_CONFIG_DIR: claudeHome };
	const line = (o: unknown): string => JSON.stringify(o);

	const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, encoding: "utf8" }).stdout.trim();
	const originDir = join(claudeHome, "projects", encClaude(top));
	mkdirSync(originDir, { recursive: true });
	const sid = "33333333-3333-3333-3333-333333333333";
	writeFileSync(
		join(originDir, `${sid}.jsonl`),
		`${[line({ type: "user", sessionId: sid, uuid: "u1", cwd: top }), line({ type: "assistant", sessionId: sid, uuid: "u2", cwd: top })].join("\n")}\n`,
	);

	try {
		run(["--name", "c2", "--agent", "claude"], { cwd: repo, env });
		const projects = join(claudeHome, "projects");
		const cloneDirName = readdirSync(projects).find((d) => d.endsWith("repo--c2"));
		assert.ok(cloneDirName, "the clone's Claude project dir exists");
		const cloneDir = join(projects, cloneDirName);
		// resume the copied-in session in the clone and add a turn (cwd = the clone path kage used)
		const firstLine = readFileSync(join(cloneDir, `${sid}.jsonl`), "utf8")
			.split("\n")
			.filter((l) => l.trim())[0];
		assert.ok(firstLine, "the copied-in session has a first line");
		const cloneCwd = JSON.parse(firstLine).cwd;
		appendFileSync(join(cloneDir, `${sid}.jsonl`), `${line({ type: "user", sessionId: sid, uuid: "u3", cwd: cloneCwd })}\n`);

		run(["finish", "c2", "--force"], { cwd: repo, env });

		// origin's original session is left untouched
		const orig = readFileSync(join(originDir, `${sid}.jsonl`), "utf8")
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
		assert.deepEqual(
			orig.map((e) => e.uuid),
			["u1", "u2"],
			"origin's original session must not be mutated",
		);
		assert.ok(
			orig.every((e) => e.cwd === top && e.sessionId === sid),
			"origin original keeps its cwd + sessionId",
		);

		// the resumed continuation comes back as a NEW, self-contained session with a fresh sessionId
		const files = readdirSync(originDir).filter((f) => f.endsWith(".jsonl"));
		assert.equal(files.length, 2, "a separate session file should be added");
		const newFile = files.find((f) => f !== `${sid}.jsonl`);
		assert.ok(newFile, "a separate session file should exist");
		const newId = newFile.replace(/\.jsonl$/, "");
		const added = readFileSync(join(originDir, newFile), "utf8")
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
		assert.ok(
			added.some((e) => e.uuid === "u3"),
			"the appended turn is preserved",
		);
		assert.ok(
			added.some((e) => e.uuid === "u1"),
			"the new session is self-contained (keeps the copied prefix)",
		);
		assert.ok(
			added.every((e) => e.sessionId === newId && e.cwd === top),
			"every line is re-identified to the new session + origin cwd",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Codex: kage leaves the global store untouched (no memory re-homing)", () => {
	const root = tmp();
	const repo = join(root, "repo");
	mkdirSync(repo);
	initRepo(repo);
	const codexHome = join(root, "codex");
	const env = { ...process.env, PATH: fakePiPath(root), PI_CODING_AGENT_DIR: join(root, "pi"), CODEX_HOME: codexHome };
	const dayDir = join(codexHome, "sessions", "2026", "05", "01");
	mkdirSync(dayDir, { recursive: true });

	const clone = join(root, "repo--cx1");
	try {
		run(["--name", "cx1", "--agent", "codex", "--no-launch"], { cwd: repo, env });
		const cloneCwd = realpathSync(clone);
		// a Codex rollout the clone produced (cwd = clone). kage must NOT touch Codex's global store —
		// re-homing it would mean rewriting Codex's versioned sqlite index, which kage deliberately won't do.
		const f = join(dayDir, "rollout-2026-05-01T00-00-00-x.jsonl");
		const before = `${JSON.stringify({ type: "session_meta", payload: { id: "s", cwd: cloneCwd } })}\n`;
		writeFileSync(f, before);

		run(["finish", "cx1", "--force"], { cwd: repo, env });

		assert.ok(existsSync(f), "kage does not delete the Codex rollout");
		assert.equal(readFileSync(f, "utf8"), before, "kage leaves the Codex rollout byte-for-byte unchanged (no cwd re-homing)");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("finish with no remote preserves the clone's commits into the origin as kage/<name>", () => {
	const root = tmp();
	const repo = join(root, "repo");
	mkdirSync(repo);
	initRepo(repo); // a plain repo with NO remote
	const env = { ...process.env, PATH: fakePiPath(root), PI_CODING_AGENT_DIR: join(root, "pi") };
	const clone = join(root, "repo--local");
	try {
		run(["--name", "local"], { cwd: repo, env });
		// commit work in the clone (still on the base branch, no remote to push to)
		writeFileSync(join(clone, "b.txt"), "x\n");
		spawnSync("git", ["add", "."], { cwd: clone });
		spawnSync("git", ["commit", "-qm", "local work"], { cwd: clone });
		const cloneHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: clone, encoding: "utf8" }).stdout.trim();

		// finish without --force should succeed (no remote -> preserve locally, not refuse)
		const r = run(["finish", "local"], { cwd: repo, env });
		assert.equal(r.status, 0, r.stderr);
		assert.ok(!existsSync(clone), "clone removed");

		// the commits now live in the origin under refs/heads/kage/<name>-<sha7>
		const ref = spawnSync("git", ["rev-parse", `kage/local-${cloneHead.slice(0, 7)}`], { cwd: repo, encoding: "utf8" });
		assert.equal(ref.stdout.trim(), cloneHead, "origin has the preserved branch pointing at the clone's commit");
		// origin's working tree was left untouched (no b.txt checked out)
		assert.ok(!existsSync(join(repo, "b.txt")), "origin working tree untouched");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("clone names are sanitized to a git-ref-safe slug (folder + no-remote preservation ref)", () => {
	const root = tmp();
	const repo = join(root, "repo");
	mkdirSync(repo);
	initRepo(repo); // no remote
	const env = { ...process.env, PATH: fakePiPath(root), PI_CODING_AGENT_DIR: join(root, "pi") };
	const clone = join(root, "repo--foo-bar"); // "foo bar" -> slug "foo-bar"
	try {
		const r = run(["--name", "foo bar"], { cwd: repo, env });
		assert.equal(r.status, 0, r.stderr);
		assert.ok(existsSync(clone), "folder suffix should be the slug 'foo-bar'");

		writeFileSync(join(clone, "b.txt"), "x\n");
		spawnSync("git", ["add", "."], { cwd: clone });
		spawnSync("git", ["commit", "-qm", "work"], { cwd: clone });
		const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: clone, encoding: "utf8" }).stdout.trim();

		const fin = run(["finish", "foo-bar", "--force"], { cwd: repo, env });
		assert.equal(fin.status, 0, fin.stderr); // must not abort on an invalid ref
		assert.ok(!existsSync(clone), "clone removed");
		const ref = spawnSync("git", ["rev-parse", `kage/foo-bar-${head.slice(0, 7)}`], { cwd: repo, encoding: "utf8" });
		assert.equal(ref.stdout.trim(), head, "preserved under a valid ref-safe branch name");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rm discards a clone (with --force)", () => {
	const root = tmp();
	const repo = join(root, "repo");
	mkdirSync(repo);
	initRepo(repo);
	const env = { ...process.env, PATH: fakePiPath(root), PI_CODING_AGENT_DIR: join(root, "pi") };
	const clone = join(root, "repo--gone");
	try {
		run(["--name", "gone"], { cwd: repo, env });
		assert.ok(existsSync(clone));
		// give the clone local-only committed work
		writeFileSync(join(clone, "b.txt"), "x\n");
		spawnSync("git", ["add", "."], { cwd: clone });
		spawnSync("git", ["commit", "-qm", "work"], { cwd: clone });
		// without --force: refuses (local-only work would be discarded without merging)
		const refused = run(["rm", "gone"], { cwd: repo, env });
		assert.notEqual(refused.status, 0);
		assert.ok(existsSync(clone), "clone should still exist after refused rm");
		// with --force: gone
		const r = run(["rm", "gone", "--force"], { cwd: repo, env });
		assert.equal(r.status, 0);
		assert.ok(!existsSync(clone), "clone should be removed");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rm accepts a clone path and works from outside any repo", () => {
	const root = tmp(); // not a git repo
	const repo = join(root, "repo");
	mkdirSync(repo);
	initRepo(repo);
	const env = { ...process.env, PATH: fakePiPath(root), PI_CODING_AGENT_DIR: join(root, "pi") };
	const clone = join(root, "repo--p");
	try {
		run(["--name", "p"], { cwd: repo, env });
		assert.ok(existsSync(clone));
		// run from `root` (NOT a git repo), passing the clone path
		const r = run(["rm", clone, "--force"], { cwd: root, env });
		assert.equal(r.status, 0, r.stderr);
		assert.ok(!existsSync(clone), "clone removed via path from a non-repo cwd");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
