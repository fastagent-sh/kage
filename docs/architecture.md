# Architecture

Which process owns what, and where the boundaries are. [Product design](design.md) defines the
experience and [README.md](../README.md) defines delivery stages. The local process below exists;
**all remote, sharing and hosting boundaries are plans, not implemented or verified behavior.**
See [known limitations](../README.md#known-limitations) for local limits.

## Processes

```text
Electron renderer ── typed preload ── Electron main ── local FastAgent (in-process)
                                         │
                                         └── planned HTTP/SSE ── protected endpoint
                                                                  │
                                         owned self-host or optional kage cloud FastAgent
                                         (its own sessions, schedules and channel adapters)
```

The renderer has `contextIsolation` on and no Node integration. It never gets arbitrary filesystem,
IPC, shell or credential access. Main owns the local runtime, directory reads and future remote
connections. FastAgent owns sessions at each location. A visitor's protected remote endpoint must
not grant direct access to another visitor's sessions. Optional hosting will operate hosted instances;
it need not proxy every conversation or own a transcript.

## The client

**Main owns every `Agent`.** Every agent is an instance of one program that ships with kage:
`program/` holds its system prompt and skill and is built by `fastagent build` into `program/dist`,
which `npm run build` makes and the app carries. A local agent is opened with
`openAgent(program, { root, config, credentials, secrets, env })` from `@fastagent-sh/fastagent` and
spoken to through the Agent API v2 (`sessions`, `messages`, `info`); a future remote connection uses
`connectAgent` from `@fastagent-sh/fastagent/client`, which is the same interface. The instance is the
agent's folder, `~/Agents/<slug>/`, which is also the agent's working directory:

```text
fastagent.json   name, model, the folders it works on (`content`), and the paths below
AGENTS.md        standing instructions, read for every message
skills/ prompts/ what the agent and the person add; read for every message, no reopen
.state/          conversations (not exported); everything else is the person's and the agent's
```

kage writes `fastagent.json`; FastAgent has no public edit of an instance's folders (its `addContent`
needs a source project), so kage reads and writes the `content` entries itself and the open validates
them. Provider variables of kage's environment and the values kage holds in `userData/secrets.json`
are the `secrets` input; only the names the program declares reach the agent's commands, and the
program declares none yet, so the window shows no secrets section until it does. `env` is the base
environment (`baseEnv(process.env)`) taken when the agent opens, plus the forwarder's proxy variables (below). A message is sent with `messages.send`, which resolves once FastAgent has recorded it; a
busy conversation takes it as a steer (`whenBusy: "steer"`). Its end arrives as `done` on the conversation's
event stream, and Stop is `sessions.cancel`. The locked FastAgent version's contract is what a remote client
builds on; bump the version with the feature that needs a newer one.

**The preload exposes typed, named operations**, not a stringly-typed gateway. It exposes only
the operations the local UI uses. Main forwards `sessions.events` on one IPC channel with an agent,
session and subscription id. The window reads a conversation's entries first and subscribes after the
last one, so FastAgent replays only what landed since and then goes live; a stream that finishes by
itself is listened to again once from the same place. Stale subscriptions cannot replace the current
view. Idle subscriptions close on navigation; running conversations retain theirs until their message
ends, so switching away does not lose streamed output. Reloading or destroying the window closes its
subscriptions, not its runs.

**Plan usage is read in main.** For an OAuth login of `anthropic`, main takes the
token from FastAgent's public `providerAuth(store, provider)` (which refreshes an
expired login under the credential file's lock, as a run would) and calls the provider's own usage
route. The route is not documented; an unexpected shape is an error, not zero. Sign in with ChatGPT has
no usage route that accepts its token (chatgpt.com answers 401), so main answers `page` instead, and opens
chatgpt.com's usage page itself when asked: the renderer names a provider, never a URL to open. The renderer
receives window percentages and reset times only.

**kage's own credential file.** Every opened agent and the sign-in receive the same
`CredentialStore`, `credentialFile(userData/auth.json)`, and plan usage opens `credentialFile` on the same path, whose lock is a file's, so a refresh anywhere takes the same one; it is never chosen from an agent default, a cached
provider probe or `FASTAGENT_AUTH_PATH`. Only that file is read: no fallback to the CLI's or pi's
store, because one OAuth grant in two files is invalidated by whichever refreshes first. Provider
environment variables still apply when the file has no credential for a provider. FastAgent
resolves credentials for the actual session model and owns OAuth refresh/writeback. The renderer
receives model specs, never the file's path or credential contents. The file is plain JSON
(`0600`); OS-backed storage is a `CredentialStore` of kage's own over the keychain, which 0.26 allows. Tests follow the same
rule, without an override: the smoke writes synthetic credentials into its isolated userData's
`auth.json`, and decoys into the CLI's and pi's stores and a `FASTAGENT_AUTH_PATH` file, which must
stay unread. The opt-in live check keeps its isolated userData but makes that `auth.json` a symlink
to the developer's real kage file, never a copy, so a real refresh writes back to the one grant;
it runs with kage closed, because each process locks the path it was given. See the
[credential policy](../README.md#how-it-works).

**Sign-in runs in main** (`src/main/providers.ts`). Main calls FastAgent's public `signIn`
with that same credential store
and relays each prompt and event to the renderer over typed IPC, one flow at a time; cancel and
window destruction abort it, which also closes the provider's local callback server. A secret
travels from renderer to main once, as an answer; no message from main to the renderer carries
credential contents. Browser and verification URLs open with `shell.openExternal` after an
`https:` (or loopback `http:`) check, never in an app window, and the renderer can reopen only a URL
the running flow reported. The provider list reads kage's file (`fastagentCredentialStore.list`),
names and ways from FastAgent (`loginOptions`, pi's provider names), and each provider's ambient
source (an environment variable) over an empty store, so a stored credential cannot hide the
variable that keeps answering after a disconnect. Custom endpoints come after the first
version; where their definitions are written is open (see [design](design.md)). Whatever the file,
kage never writes an entry for a built-in provider id: a `baseUrl` override there would outlive the
credential it was entered with and send a later subscription token or official key to the relay.

**One network route, owned by Chromium.** Node's `fetch` ignores the system proxy, and a
proxy read once at startup misses a VPN client switched on later, PAC rules and the system bypass
list. Main therefore installs an undici dispatcher that asks `session.resolveProxy(url)` for each
new connection and maps the answer (`DIRECT`, `PROXY`, `HTTPS`, `SOCKS5`) to undici agents; the
Network setting only changes the session's proxy configuration (`system`, fixed rules, or
`direct`), and proxy variables present at launch are translated into the same configuration. A
spike on macOS with Clash Verge in system-proxy mode confirmed that `resolveProxy` returns the
proxy for provider hosts and `DIRECT` for loopback, private ranges and `.local`, and that a Node
`fetch` without it reached Anthropic directly and got HTTP 403. With the dispatcher installed, a
real Codex run streamed through Clash and its `bash` tool saw the proxy variables; a proxy that is
not listening fails the page's connection check with `ECONNREFUSED` and the proxy's address; the
same check reached Anthropic through Clash's SOCKS5 port. Picking up a
system proxy switched while kage runs is expected from Chromium's configuration watcher, and the
dispatcher asks per request, but switching one was not tested. Only the first entry of a PAC list
is used, and proxy authentication is unsupported until a real user needs it: Chromium's route answer
(`PROXY h:p`) carries no credentials. A launch variable with a user name or password therefore fails
every request with that explanation instead of the proxy's bare 407.

Agent commands cannot use the dispatcher: they are child processes, whose environment FastAgent assembles
once, when the agent opens, from the `env` kage passes, and a running process cannot be given a new one.
So kage runs a forwarding proxy on loopback (`src/main/forward.ts`, started with the first agent) and gives
every agent's commands one fixed route to it: `HTTPS_PROXY`, `HTTP_PROXY` and `ALL_PROXY` in both spellings,
and `NO_PROXY` set to `localhost,127.0.0.1,::1`. For each connection the forwarder asks Chromium's
`resolveProxy` for that URL and connects directly, through an HTTP or HTTPS proxy (`CONNECT`) or through
SOCKS5, the way Clash or Surge serve a system proxy. A route that changes reaches the next connection of
a command already running, and per-host PAC rules and the system bypass list apply to commands as they do
to model requests. A route kage cannot take is a `502` with the reason, never a direct connection. The
forwarder listens on loopback only and takes no credentials, so any local process could use it as it could
use the system proxy itself. Proxy variables present at launch are the commands' own and are left untouched.

**An agent's default model is kage's, applied by kage.** The registry's model overrides the config's
for new conversations: a conversation is created with it, and one with no model of its own is given it
when its first message is sent, so what the chip showed, what runs and what the history records agree.
Changing it updates the open conversation (when there is one) and then the registry; nothing is rebuilt
and no subscription moves. A default the agent's providers no longer offer opens the agent all the same,
with the picker saying so, and a send on it is refused as `model_unavailable` before anything is recorded.
Removing or moving an agent, or replacing its config, closes its instance, so it waits for no running
conversation and refuses while one is at work, and ends its subscriptions saying why. Updating the
conversation and the registry is not a cross-file transaction; a registry write failure after a session
update leaves the conversation's model changed without changing the default.

**Renderer state is a plain TS store read through `useSyncExternalStore`.** No state library: the
authoritative state lives in FastAgent and is re-read (`sessions.get`, `sessions.entries`) rather than
derived from our own writes. Conversation titles are not stored anywhere: a list row is quoted from
the newest `user` entry of its session, read with the list. Agent resources own the model list, commands and their read identities;
every navigation starts a new identity even when returning to the same agent. Leaving the agent or
closing the picker invalidates its unfinished reads. Provider usage owns its plan snapshots and
per-provider read identities; disconnecting or replacing a login invalidates both. The settings
slice rejects reads from a superseded opening or an earlier network choice. These results never
need a component to decide whether they still belong on screen.

**The client persists almost nothing** — `userData/agents.json`: currently each agent's id, name,
directory, avatar colour and optional model override. Reads validate the file; only a missing file means an empty
registry. Writes serialize read/modify/rename, so concurrent changes do not lose rows and a failed
write never publishes an in-memory success. Conversations remain the runtime's files. The renderer
persists drafts and selection in localStorage. The draft storage boundary preserves an invalid value in
`kage.drafts.unreadable` before allowing new writes. If reading or preserving it fails, the original key
stays protected until a reload with working storage. A save failure is shown in the window; editing stays
available, and the next publication retries the unsaved value. Only a successful write suppresses a repeat
save. Selection remains best effort. Live output and attention marks are presentation
state, not a second durable transcript. Remote contacts and credentials are future work: never
store access tokens alongside contact metadata; use OS-backed secure storage for secrets. Model
credentials live in kage's own `userData/auth.json`, written through FastAgent's credential store. App preferences
(the network mode and the avatar style) live in `userData/settings.json`, validated on read; an unreadable file is an
error, not a first run.

`ponytail:` one JSON file with atomic writes; move to SQLite when a list of agents stops fitting in
memory, which is not a real horizon for this product.

## Copies of an Agent and online contacts (planned)

A copy of an Agent carries only its reviewed harness and the contexts its owner chose to include as
their types allow; the recipient's copy has a separate owner and separate runtime state. Do not
package `.state/`, `.git` internals or anything outside the Agent
and its chosen contexts. The recipient supplies their own model and service
credentials. An online invitation instead points to the owner's existing runtime. An individual
revocable invite may initially mean "anyone holding this link"; it must not claim to identify a
named person. If named recipients are required, add authentication before making that promise.

A protected endpoint must enforce the invite boundary in front of the whole `/v1` Agent API. FastAgent's
one credential of its own, `FASTAGENT_API_KEY`, is a key for the entire instance, and an instance is one trust
domain ([security boundary](https://github.com/fastagent-sh/fastagent/blob/main/docs/design/security-boundary.md)),
so a shared host brings its own boundary and does not hand a visitor the key. A raw instance-wide
`sessions.list` enumerates everyone's sessions, so the host must scope reads, writes and events to the
visitor's own sessions without storing a second transcript; visitors who must not see each other get an
instance each. Owner-only
schedules, Agent updates and hosting controls must not be exposed through a visitor invite.
The concrete host-side access boundary needs a tested design at stage 3, not a client-only filter.

Each location owns its own session store: local history stays local, online history stays with its
host, and channel group history does not become a private desktop conversation. The renderer owns
drafts and selection (currently keyed by local agent and session); online contacts must also key
them by location and reject late events from superseded subscriptions. Main owns runtimes and
subscriptions and forwards events with their origin identifiers. A disconnect leaves execution status unknown until the runtime is consulted; never
reissue accepted work merely to restore a stream.

## Online execution and schedules

**Planned.** Stage 3 connects to an already-running, protected instance owned by the user. Stage 4 offers a
hosted alternative: publish a reviewed Agent snapshot (with its contexts as their types allow), set required model/channel secrets on
the host, provision durable runtime state, and provide update and stop controls. The desktop can
close without stopping online turns or scheduled work. Owner-hosted agents do not depend on our hosting
service; kage cloud needs only hosting and access metadata, not a centralized chat store.
Do not claim a specific Fly topology, sign-in provider or price before verifying the hosting path.

Timed work is a **schedule**: `src/schedules/<name>.ts` in the Agent's directory, default-exporting
`defineSchedule({ cron, tz?, prompt })` (FastAgent 0.25). It is code, so kage cannot write one without
TypeScript, and a change takes effect at the next start. Every fire continues one session of that schedule's own, which holds what each run
**said**. How each fire **ended** is not in it: the host's fire history records it (`completed`, `failed`,
`skipped` when the previous fire still held the session), in claim files under its state root,
`schedule/claims/<name>/`. Neither the list of an instance's schedules nor their fire history has a remote
route: in process, `serve()` loads them, and on the host `fastagent schedules run <name>` fires one now.
If kage needs them remotely, ask FastAgent for a route rather than infer them from files or from the session.
(Written against 0.27 for planning; verify each claim against the locked version before building stage 3.)

A clock must remain available while the owner's laptop is off. On Fly or Railway a schedule is the agent's own
clock and keeps the machine resident; a sleeping machine cannot wake itself for its own cron. On AgentCore the
container mirrors schedules into one-shot EventBridge alarms that wake it, so it scales to zero with the schedule
itself. Elsewhere, scaling to zero means a clock outside the instance sending the prompt through the Agent API
*in place of* the schedule, never beside it (both would fire into the schedule's session). That route
is a key for the whole instance, so it needs a gateway in front, and the outside clock needs demonstrated delivery, authorization, deduplication and
honest failure/skip reporting before it replaces residency.

Until a remote instance's fire history can be read, its schedules' outcomes are "outcome unavailable": never
inferred from the `schedule:<name>` session (a skipped or interrupted fire leaves nothing there, or a partial
run) nor from a declaration. A successful send or invoke
admission is not a successful outcome. Never auto-replay scheduled work that may already have happened.
These are data-integrity constraints, not an enterprise audit UI.

## State ownership

| State | Owner | Boundary |
|---|---|---|
| Agent | its own directory in `~/Agents/<name>/` / a recipient's own copy; the program it runs ships with kage | Only the folder without `.state/` and the chosen contexts travel; moved to the Trash when the agent is removed from kage. |
| Context | its project or folder, outside every Agent directory; a host's copy or clone in that instance's state | Never moved or deleted by removing an Agent. |
| Local conversations | the Agent's own `.state/` (`~/Agents/<name>/.state/agent.sqlite`) | Already implemented; not uploaded on publish; go to the Trash with the agent's folder. |
| Online and channel conversations | FastAgent on the owner-controlled host | Access-scoped per visitor or channel, no second client transcript. |
| Invitation and endpoint access | host-side protection, with optional hosting metadata | Revocable; do not put secrets in a public URL without labeling its bearer semantics. |
| Model and channel credentials | kage's own `userData/auth.json` for local agents; each remote runtime's credential store or host secrets | Never copy an OAuth login between stores or into a hosted instance. |
| Custom model endpoints kage adds (planned) | open: see [design](design.md) (an agent's config declares providers; there is no machine-level catalog) | Local to this machine; not part of a copy of an Agent or a hosted instance. |
| App preferences | `userData/settings.json` | Network mode and avatar style; never credentials. |
| Schedule declaration and execution | the Agent's `schedules/` + the running host and clock; how each fire ended in the host's fire history, what it said in its `schedule:<name>` session | Display only verified schedules and outcomes. |
| Drafts and attention markers | the client | Drafts persist locally; markers are presentation state. |

No universal message database, enterprise membership/approval/audit system, web workbench, social
network or native group router is needed for the first four stages. A native group would require
sender attribution and shared-session semantics that today's Agent API does not expose;
existing FastAgent channel groups remain the first group path. Full-process sandboxing and general
exactly-once execution are not shipped by FastAgent: untrusted use of powerful tools needs separate
isolation before being offered.
