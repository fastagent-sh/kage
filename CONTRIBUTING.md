# Contributing to kage

Use GitHub Flow: one focused branch, one reviewed PR, one squash commit on `main`.
All repository-facing text is English. Product scope comes from [README.md](README.md),
[design](docs/design.md), [interactions](docs/interaction.md) and [architecture](docs/architecture.md).
A working implementation is not evidence that all of a milestone's user workflows are accepted.

## Set up and verify locally

Use Node 24.15 or later and npm. FastAgent is an exact version from npm (`@fastagent-sh/fastagent` in
`package.json` and the lockfile), so a standalone checkout is all there is to set up:

```bash
git clone https://github.com/fastagent-sh/kage.git kage
cd kage
npm ci
npm test
npm run build
npm run dev
```

`npm run build` includes TypeScript checking and the Electron main/preload/renderer builds.
kage does not follow a moving FastAgent branch or a local checkout of it: what CI runs is what
you run. A FastAgent API change must be released upstream first, then the exact version is bumped
in the same kage PR that consumes it (`npm install @fastagent-sh/fastagent@X.Y.Z --save-exact`),
with `npm test`, `npm run build` and `npm run test:smoke` run against it.

Verify locally before pushing. CI is confirmation, not the first debugging environment.

## Issues and milestones

Questions and ideas go to [Discussions](https://github.com/fastagent-sh/kage/discussions); issues are
for bugs and concrete feature requests. Security reports never go in an issue: see
[SECURITY.md](SECURITY.md).

Use the Bug, Feature or Task form. The forms set the GitHub issue type and initial label. With
push access, CLI-created issues must set them explicitly because `gh` does not consume YAML forms:

```bash
gh issue create --type Bug --label bug --title 'bug: <observable failure>' --body '<reproduction>'
gh issue create --type Feature --label enhancement --title 'feat: <user outcome>' --body '<acceptance criteria>'
gh issue create --type Task --label chore --title 'task: <outcome>' --body '<scope and verification>'
```

- Link an existing milestone and related interaction/acceptance IDs instead of creating duplicates.
- `priority:P0` means a milestone blocker; `priority:P1` means planned work after blockers. These
  labels are planning order, not incident severity. Do not silently move work into Week 1.
- Assign the person doing the work when they pick it up; do not invent deadlines or assignees.
- Close an issue with actual verification evidence, not just a code diff or passing mocks.
- A PR's `Closes #N` closes the issue on merge, but does not copy its milestone or priority to the PR.

## Branch and PR loop

Without push access, fork the repository and open the PR from a branch of your fork; the same
branch names, checks and review apply.

Branch prefixes follow FastAgent: `feature/` (`feat/` also accepted), `fix/`, `refactor/`, `docs/`,
`chore/`, `ci/`, `test/`. Never push directly to `main`.

```bash
git switch -c fix/<focused-change>
# Make and verify the change.
npm test && npm run build
git push -u origin HEAD
gh pr create --base main --assignee @me --milestone '<milestone of the issue>' \
  --body 'Closes #<issue>

<final behavior, verification, known limitations>'
```

Fill the PR sidebar before asking for review: assignee (yourself), intent label, and the same
milestone as the issue it closes when that issue has an open one — omit `--milestone` otherwise
instead of inventing one. `Closes #N` in the body populates Development; a PR that only does part of
an issue writes `Part of #N` and leaves Development empty rather than closing work that is not done.
Fix an existing PR with `gh pr edit <n> --add-assignee @me --add-label <label> --milestone <title>`.
Leave Projects alone; the repo does not use project boards. Drop `--assignee @me` if you lack push
access. Branch-prefix automation adds the PR's intent label; CODEOWNERS requests maintainers. An
unknown branch prefix needs a manual label. Automation and review routing take effect after these
files land on the default branch.

PR titles use `type(scope): summary`. The final PR title/body become the squash commit message:
explain final behavior, necessary rationale and known limitations, not intermediate attempts.
Keep unrelated refactors separate. Include issue links, tests actually run, tests not run, and
sanitized screenshots for visible UI changes. Read review bodies, conversation comments and inline
threads; address every item before resolving its thread.

## Product-specific verification

`Desktop checks` runs tests, a production build, `node tests/smoke.mjs`, `node tests/transcript.mjs` and `node tests/quit.mjs` on
macOS with Node 24.15 or later — all three launch a real Electron window, so they run on the only platform kage supports. The
smoke drives the real Electron/preload/IPC/FastAgent stack with synthetic credentials and fake HTTP. The
transcript check holds runs at the steps the live end of a run must draw as one line (calls running, a
thought, an answer being written, a retry waited out) against a local fake model endpoint. The quit check
starts a run that does not end, answers "Quit anyway", and after Electron exits opens the instance as the next
launch would: the message must be canceled and its tool not run again. Run
`npm run test:smoke` locally to build and run all three. A second job, `Package (macOS)`, builds the app and its dmg,
checks that the bundle carries every module it needs, runs the installed app outside the checkout against a fake
model endpoint, and keeps the dmg as an artifact; `npm run test:package` does the same locally. None of these checks signing or
notarization, and none claims Windows/Linux support, real-provider/OAuth validation or full Week 1 acceptance. The
[release gate](https://github.com/fastagent-sh/kage/issues/16) still requires workflow evidence.

`npm run test:perf` measures a long conversation (open, scroll, a new turn streaming) and is run by hand before
and after a change to how the transcript renders; it depends on the machine, so it is not in CI.

For changes to local agent workflows, verify the relevant cases:

- the displayed model, actual conversation model and credential source agree, including history
  whose provider differs from the agent default;
- drafts, output, errors and queues remain attached to their conversation across navigation;
- a background run remains observable/stoppable, and failed operations preserve its control path;
- registry/scaffold writes do not destroy existing data, and rejection is not shown as delivery;
- Enter, Shift+Enter, IME input, Escape priority and focus restoration work in Electron;
- history/reconnection reports missing runtime fields honestly and does not replay accepted work.

Automated tests must use isolated fixtures and fake model responses. Never stage a developer's
`auth.json`, OAuth refresh token, model key or private transcript in Actions, test artifacts or
issue/PR evidence. Real-provider and proxy checks run locally against the developer's own
credentials and must be reported separately from mocked checks. No cloud or paid live-test workflow
is configured.

## Review and merge policy

A maintainer makes the merge decision. Green CI means **ready for review/merge**, not permission
for a coding agent to merge. External-contributor PRs need maintainer review; a second maintainer
review is recommended for credential handling, IPC/security boundaries, persistence and workflows.

Repository settings allow squash merges only, use the PR title/body, delete merged branches, and
allow updating a PR branch and auto-merge, which merges a PR once its required checks pass. Workflow
approval of PRs is disabled. Do not force-push
or delete `main`; require resolved review conversations and green `Desktop checks` and `CodeQL` before merging.

`main` is protected server-side with the settings versioned in
[.github/main-protection.json](.github/main-protection.json): `Desktop checks` and `CodeQL` must pass
on a branch up to date with `main`, review conversations must be resolved, history stays linear,
and the rules apply to admins too. After changing that file, a repository admin applies and verifies it:

```bash
gh api --method PUT repos/fastagent-sh/kage/branches/main/protection \
  --input .github/main-protection.json
gh api repos/fastagent-sh/kage/branches/main/protection
```

After an explicitly authorized merge:

```bash
git switch main
git pull --ff-only
git branch -d <merged-branch>
git fetch --prune origin
```

A **stacked** PR, one based on another open PR's branch, needs one extra step once its parent merges: rebase
it onto the new `main` (`git rebase --onto main <parent-branch> <branch>`) and force-push, rather than using
the PR's *Update branch*. Updating replays the parent's original commits, which `main` now holds as a squash,
so it reports conflicts that the rebase does not; the rebase also leaves the PR showing only its own commits.
GitHub retargets the PR to `main` once the parent's branch is deleted.

## Releases

A release is the macOS app (`kage-X.Y.Z-arm64.dmg`) attached to a GitHub Release `vX.Y.Z`. Start from a
clean, up-to-date `main` with an authenticated GitHub CLI:

```bash
npm run release:patch   # or release:minor / release:major / node scripts/release.mjs X.Y.Z
```

The script refuses to start from anything but a clean `main` identical to `origin/main`, or for a version
whose branch or tag exists. It bumps `package.json` and the lockfile on `chore/release-X.Y.Z`, runs
`npm test`, `npm run test:package`, `node tests/smoke.mjs`, `node tests/transcript.mjs` and `node tests/quit.mjs`, and opens the
PR. It never merges, tags or creates the Release. After a maintainer squash-merges the PR, a repository
admin tags that merge commit (check `git log -1` is `chore: release X.Y.Z (#N)`):

```bash
git switch main && git pull --ff-only
git tag vX.Y.Z && git push origin vX.Y.Z
```

The tag starts `.github/workflows/release.yml` in the protected `release` environment, which waits for a
maintainer's approval. It builds the commit the tag pointed to when pushed (a re-run builds the same one),
checks that the tag is the package's version and on `main`, runs the unit tests, builds the dmg, runs the
packaged app outside the checkout, and creates a **draft** Release `vX.Y.Z` with generated notes, the dmg
and its SHA-256. Read the draft, then publish it:

```bash
gh release edit vX.Y.Z --draft=false
```

A Release becomes public, and the one README's install link points to, only with its app attached. A
failed run creates no Release: re-run it when the cause was the runner, and release a new version when
it was the code. A run that failed after creating the draft leaves it; delete the draft before
re-running. The "Protect release tags" ruleset lets only repository admins create `v*` tags and refuses
updating, moving or deleting them to everyone else; admins can bypass it but do not: a broken release is
followed by a new version, never re-tagged. Generated notes group merged PRs by their type label
(`.github/release.yml`).

The app is ad-hoc signed, not with an Apple Developer ID, and not notarized, so macOS refuses its first
open; README.md says how to open it. Signing, notarization and automatic updates wait for a Developer
ID: macOS only updates a signed app in place.

## Dependencies and Actions

- Actions are SHA-pinned. Default `GITHUB_TOKEN` permissions are read-only; the metadata-only
  labeler alone gets PR-write permission and must never check out or execute PR code. The release
  workflow alone gets `contents: write`, to attach the release's assets, behind its environment's
  approval.
- Dependabot checks GitHub Actions weekly. npm/FastAgent version updates remain ordinary reviewed
  PRs; FastAgent is pinned to an exact version and bumped with the change that consumes it.
  Keep `package.json` and the lockfile consistent.
- Vulnerability alerts are enabled. Review alerts and fix dependencies manually as needed; do not
  assume automatic npm fixes or advisory/code scanning cover every dependency.
- CodeQL analyzes every PR, `main` and a weekly schedule (`.github/workflows/codeql.yml`). Secret
  scanning with push protection is enabled. Neither replaces review of the boundaries in
  [SECURITY.md](SECURITY.md); never treat a clean scan as a security result.
- Do not change visibility, collaborators, licensing or billing as part of ordinary code work.

Keep durable guidance here, in `AGENTS.md`, or in `docs/`. Do not commit temporary plans, handoffs,
execution logs or machine-specific state.
