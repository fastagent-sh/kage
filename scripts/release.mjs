#!/usr/bin/env node
/** Opens a verified release PR. It never merges, tags or creates the Release; pushing the tag does that. */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";

const BUMP_TYPES = new Set(["major", "minor", "patch"]);
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function usage() {
  console.log(`Usage: node scripts/release.mjs <major|minor|patch|x.y.z> [--yes]

Creates a verified release pull request. It does not merge, tag or create the
GitHub Release.

Options:
  --yes  Skip the confirmation prompt`);
}

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, { encoding: "utf8", stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`Command failed: ${command} ${args.join(" ")}${output ? `\n${output}` : ""}`);
  }
  return result;
}

const capture = (command, args) => run(command, args, { capture: true }).stdout.trim();

function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
}

function nextVersion(current, target) {
  if (SEMVER_RE.test(target)) {
    if (compareVersions(target, current) <= 0) throw new Error(`Target version ${target} must be greater than current version ${current}.`);
    return target;
  }
  const [major, minor, patch] = current.split(".").map(Number);
  if (target === "major") return `${major + 1}.0.0`;
  if (target === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

async function confirm(version) {
  if (process.argv.includes("--yes")) return true;
  if (!process.stdin.isTTY) throw new Error("Confirmation requires an interactive terminal; pass --yes to continue non-interactively.");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(?:es)?$/i.test((await prompt.question(`Create a release PR for v${version}? [y/N] `)).trim());
  } finally {
    prompt.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) return usage();
  const target = args[0];
  const unknown = args.slice(1).filter((arg) => arg !== "--yes");
  if (!target || unknown.length > 0 || (!BUMP_TYPES.has(target) && !SEMVER_RE.test(target))) {
    usage();
    throw new Error("Expected one release target: major, minor, patch, or x.y.z.");
  }

  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  if (pkg.name !== "duang") throw new Error("Run this script from the duang repository root.");
  if (!SEMVER_RE.test(pkg.version)) throw new Error(`Current version is not a stable semantic version: ${pkg.version}`);
  if (capture("git", ["branch", "--show-current"]) !== "main") throw new Error("Releases must start from the main branch.");
  if (capture("git", ["status", "--porcelain"])) throw new Error("Working tree is not clean. Commit or stash changes first.");
  if (run("gh", ["auth", "status"], { allowFailure: true, capture: true }).status !== 0) {
    throw new Error("GitHub CLI is unavailable or not authenticated. Run `gh auth login` first.");
  }
  run("git", ["fetch", "origin", "main", "--tags"]);
  if (capture("git", ["rev-parse", "HEAD"]) !== capture("git", ["rev-parse", "origin/main"])) {
    throw new Error("Local main is not identical to origin/main. Run `git pull --ff-only` first.");
  }

  const version = nextVersion(pkg.version, target);
  const tag = `v${version}`;
  const branch = `chore/release-${version}`;
  if (run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { allowFailure: true, capture: true }).status === 0) {
    throw new Error(`Local branch already exists: ${branch}`);
  }
  if (capture("git", ["ls-remote", "--heads", "origin", branch])) throw new Error(`Remote branch already exists: ${branch}`);
  if (
    run("git", ["show-ref", "--verify", "--quiet", `refs/tags/${tag}`], { allowFailure: true, capture: true }).status === 0 ||
    capture("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`])
  ) {
    throw new Error(`Tag already exists: ${tag}`);
  }

  console.log(`\nCurrent version: ${pkg.version}\nTarget version:  ${version}\nBranch:          ${branch}\n`);
  if (!(await confirm(version))) return console.log("Release cancelled.");

  run("git", ["checkout", "-b", branch]);
  run("npm", ["version", version, "--no-git-tag-version"]);
  run("npm", ["test"]);
  run("npm", ["run", "test:package"]);
  run("node", ["tests/smoke.mjs"]);
  run("node", ["tests/transcript.mjs"]);
  run("node", ["tests/quit.mjs"]);

  run("git", ["add", "package.json", "package-lock.json"]);
  run("git", ["commit", "-m", `chore: release ${version}`]);
  run("git", ["push", "-u", "origin", branch]);
  const body = [
    `## Release ${tag}`,
    "",
    `Bump duang from ${pkg.version} to ${version}.`,
    "",
    "### Verification",
    "",
    "- `npm test`",
    "- `npm run test:package` (type check, build, package, and the installed app run outside the checkout)",
    "- `node tests/smoke.mjs`",
    "- `node tests/transcript.mjs`",
    "- `node tests/quit.mjs`",
    "",
    "### After merge",
    "",
    `Tag the merge commit \`${tag}\` and push the tag (CONTRIBUTING.md#releases): its workflow builds the app and drafts the Release, which a maintainer then publishes.`,
  ].join("\n");
  const pr = capture("gh", ["pr", "create", "--base", "main", "--head", branch, "--assignee", "@me", "--title", `chore: release ${version}`, "--body", body]);

  console.log(`\nRelease PR created: ${pr}`);
  console.log(`After a maintainer merges it, tag the merge commit ${tag} and push the tag (CONTRIBUTING.md#releases).`);
  console.log(`The release branch remains checked out at ${branch}.`);
}

main().catch((error) => {
  console.error(`\nRelease failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
