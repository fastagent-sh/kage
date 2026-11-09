# kage

[![CI](https://github.com/fastagent-sh/kage/actions/workflows/ci.yml/badge.svg)](https://github.com/fastagent-sh/kage/actions/workflows/ci.yml)
[![CodeQL](https://github.com/fastagent-sh/kage/actions/workflows/codeql.yml/badge.svg)](https://github.com/fastagent-sh/kage/actions/workflows/codeql.yml)
[![license](https://img.shields.io/github/license/fastagent-sh/kage.svg)](LICENSE)
[![built on FastAgent](https://img.shields.io/badge/built%20on-FastAgent-0b7285.svg)](https://github.com/fastagent-sh/fastagent)
![platform](https://img.shields.io/badge/platform-macOS%20(Apple%20silicon)-555.svg)

**A native, local-first workbench for [FastAgent](https://github.com/fastagent-sh/fastagent) agents.**

Give an agent work, follow a long run while you do something else, come back to what actually
happened, and continue. Your agents sit in a sidebar like contacts; each conversation is a
FastAgent session, read from the agent's own runtime rather than copied into a second store.

<p align="center">
  <img src="docs/screenshots/reading-light.png" alt="kage: two agents in the sidebar, and a conversation with a code block, a table and mixed English and Chinese text" width="860">
</p>

> **Status: early.** kage runs agents on your Mac only (Apple silicon), and its releases are not signed
> yet. Online agents, giving someone an agent and hosting are [planned](#roadmap), not built.

## Why

Making an agent in a terminal is easy now. Living with one is not: a long run scrolls past, switching
to something else loses track of it, and coming back means reading a log to find out whether it
worked. kage is the place you give an agent work and come back to the result. FastAgent supplies the
runtime; kage adds no transcript, database or agent format of its own.

## What it does

**Agents as contacts.** Each agent row quotes the newest output of its conversation, says `working`
while a run is going, and counts results you have not looked at yet (also on the Dock icon). Its
avatar's face shows what kind of work it is doing. Clicking an agent returns to the conversation you
left it on.

**Conversations that survive leaving.** Runs keep going when you switch agents or conversations.
Coming back finds the line you were reading; after a restart, the window reopens the same agent and
conversation with your unsent draft. History is read from FastAgent, so a run driven from elsewhere shows up too. Long
conversations open at their latest turn at once and fill in above it.

**A transcript you can read.** Answers render as Markdown with highlighted code. Tool calls and
thinking fold into one line per stretch of work (`thought 4s, read 2 files, ran 3 commands`) that opens for the
details. The live end of a run is said once: the step running, a retry being waited out
(`retrying 2/3`), or a model that has gone quiet (`no output for 45s`).

**Steer, stop, retry.** Type while a run is going to steer it; Esc stops it. A run that failed after
taking your message offers Retry, which first asks when the run had already used tools, because the
agent may repeat that work. Nothing is ever resent on its own.

**Models and effort per conversation.** The picker lists what the open agent can run: pi's built-in
models and the providers the agent's config declares, for providers you have connected. Each
conversation keeps its own model and reasoning effort; the agent's default only applies to
conversations that never chose. FastAgent fetches models released since when an agent opens.

**Providers connected in the app.** Sign in with a subscription (Claude Pro/Max, ChatGPT, GitHub
Copilot and the other flows FastAgent supports) in the system browser, or paste an API key, which is
checked once with the provider before it is saved. The header shows how full the conversation's
context is and, for a Claude subscription, the plan's usage windows.

**Problems that say what to do.** A failure keeps the provider's original words and adds what they
mean and the way on: **Sign in again** for a rejected login, **Use another model** for an overloaded
provider, **Network settings** for a connection error,
**Start a fresh config** for an agent whose config no longer loads (the old file is kept beside it).

**Works behind a proxy.** Every model and sign-in request follows the system proxy as it is at that
moment, including PAC rules and a VPN switched on later; Settings → Network can fix a proxy or turn
it off, and checks the route. The agent's own commands (`git`, `npm`) get the proxy too.

Also: `/` completes the agent's skills, extension commands and prompt templates; light and dark
follow the system; seven avatar styles; the sidebar and transcript work from the keyboard.

## Install

Requirements: macOS on Apple silicon. Earlier releases keep their original app and asset names;
`kage`-named downloads start with the next release.

1. Download `kage-<version>-arm64.dmg` from the
   [latest release](https://github.com/fastagent-sh/kage/releases/latest), open it and drag kage to
   Applications.
2. The app is not signed with an Apple Developer ID or notarized yet, so macOS refuses the first open
   ("Apple could not verify…"). Click **Done**, then open System Settings → Privacy & Security, find
   kage near the bottom, click **Open Anyway** and confirm. macOS remembers the choice.

Each release lists the dmg's SHA-256 (`shasum -a 256 kage-<version>-arm64.dmg` to compare). To update,
download the new release and replace the app; there are no automatic updates until the app is signed.

**From source** (Node 24.15 or later and npm): `git clone https://github.com/fastagent-sh/kage.git`, then
`npm ci && npm run package` builds the same dmg into `dist/`.

## Getting started

1. **Create an agent.** Click **+** at the top of the sidebar, name the agent and attach any folders on
   this computer it should work on. kage creates the agent in `~/Agents/<name>/` with FastAgent's starter
   files and a git repository.
2. **Connect a provider.** Settings (`⌘,`) → Model providers, or **Connect a provider** in the model
   picker.
3. **Pick a model and send.** A new agent has no default model, so its first conversation asks for
   one. `⌘N` starts a new conversation.

## How it works

```text
renderer (React) ── typed preload API ── Electron main ── FastAgent, in-process
```

- **Main owns the runtime.** Each agent is opened with FastAgent's public `openAgent`, inside
  Electron main, without opening a local port, as its own instance in kage's data directory. The renderer runs with
  context isolation and no Node access; it gets named operations, never the filesystem, a shell or
  credentials.
- **No second transcript.** Conversations live in kage's instance of each agent (FastAgent's own
  storage). kage reads history and live events through the Agent API; it stores only presentation state (drafts, the open
  conversation, where you were reading).
- **kage's own files** live in its data directory, `~/Library/Application Support/kage/`:
  `agents.json` (the agents you added), `settings.json` (network and avatar style) and `auth.json`
  (provider credentials). Writes are atomic, and a file that cannot be read is reported with its
  original error, never treated as empty or overwritten.
- **One credential file.** kage reads only its own `auth.json`, not the `fastagent` CLI's, pi's or a
  project's: one OAuth login kept in two files is invalidated by whichever refreshes first. A login
  made in a terminal is made again in kage. Provider environment variables still apply.
- **One instance.** Only one kage runs per data directory; starting another brings the running one
  forward. The installed app and `npm run dev` share the directory.

More: [architecture](docs/architecture.md) (processes, state ownership, network route),
[interaction](docs/interaction.md) (behavior and failure handling), [design](docs/design.md)
(surfaces and flows) and [UI](docs/ui.md) (interface principles).

## Known limitations

- macOS on Apple silicon only; not signed or notarized, and no automatic updates.
- Conversations cannot be renamed or deleted: FastAgent's sessions have neither. A conversation is titled by
  the newest message you sent in it.
- Messages queued from another window or a channel appear when they enter the conversation, not before.
- The app uses `~/Library/Application Support/kage/`. It does not import the former app's registry,
  credentials, conversations or drafts; its old data directory is left untouched. Reconnect providers
  in kage rather than copying OAuth credentials between stores.
- Sessions of earlier versions are not read: this version keeps its own instance of each agent.
- Removing an agent moves its directory in `~/Agents/` and kage's conversations with it to the Trash; the folders it works on stay on disk.
- Credentials are a plain JSON file (mode `0600`), as FastAgent writes it, not the macOS Keychain
  ([fastagent#652](https://github.com/fastagent-sh/fastagent/issues/652)).
- A proxy that needs a user name and password is not supported.
- History read back has no durations (how long a call or a thought took), and output streamed before
  a reload that never became an entry is not replayed.
- Token counts and cost are not shown. A Claude subscription's usage comes from an endpoint
  Anthropic does not document; Sign in with ChatGPT links to its usage page instead.
- A command name typed by hand that the agent does not know goes to the model as plain text.
- Attachments and voice input are not implemented.
- kage does not run an agent's schedules or channels, and has no online agents or sharing yet.

## Roadmap

Each stage is an outcome that has to be shown working with real use, not a date
([how that is measured](docs/design.md#how-we-know-it-worked)). The first local
milestone ([Week 1](https://github.com/fastagent-sh/kage/milestone/1)) is accepted; stage 1 is in
progress; the rest are planned.

1. **Daily local workbench.** Create an agent with the folders it works on and the ones it should
   know, use it every day without a terminal, and inspect what it loaded and changed.
2. **Give someone the Agent.** They get their own copy, connect their own credentials and keep their
   own conversations. No secrets, runtime state or machine-only paths travel with it.
3. **Online contacts.** Connect your own protected, already-running agent, including one that runs
   schedules while your laptop is closed; then invite someone else to it, each visitor seeing only
   their own conversations, revocably.
4. **Optional hosting.** Publish, update and stop an agent without operating a server, with
   schedules that actually run while the laptop is off.
5. **Groups and discovery,** only if existing chat channels and direct invitations prove not enough.

The words follow FastAgent's agent model ([fastagent#684](https://github.com/fastagent-sh/fastagent/issues/684)):
an **Agent** is a definition in a directory of its own, a **context** is a folder it works on or
knows, an **instance** is one Agent running in one place, and a **conversation** is a FastAgent
session of one instance. [Design](docs/design.md) describes each stage's flows.

## Development

```bash
npm run dev           # Electron + Vite; main and preload edits restart the app
npm test              # unit tests
npm run build         # type check and build
npm run test:smoke    # the real app with a fake model: the local workflow, then the live transcript
npm run shots         # screenshots of the real window in both colour modes, into out/shots/
npm run test:package  # package, then run the installed app outside the checkout
npm run test:perf     # timings on a 150-turn conversation (machine-dependent, not in CI)
KAGE_LIVE=1 npm run test:live  # opt-in: real provider calls with this machine's kage logins; two providers, any two
```

FastAgent is pinned to an exact published version. Automated tests use isolated data and fake model
endpoints; only `test:live` talks to real providers, spends model credits, and must run while kage
is closed.

## Contributing

Issues, discussions and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup,
the branch and PR workflow and what to verify. Questions and ideas go to
[Discussions](https://github.com/fastagent-sh/kage/discussions). Report a vulnerability privately as
described in [SECURITY.md](SECURITY.md), never in a public issue.

## License

[MIT](LICENSE). Bundled fonts are under the SIL Open Font License (`src/renderer/fonts/OFL-*.txt`);
provider logos are LobeHub's, under their license (`src/renderer/provider-logos/LICENSE`); avatar
styles are DiceBear's (CC0, except Bottts, free for personal and commercial use).
