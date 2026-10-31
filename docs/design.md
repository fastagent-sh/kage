# Product design

The product and delivery gates are in [README.md](../README.md). This document defines the
surfaces and flows; [interaction.md](interaction.md) covers behavior and failures, [ui.md](ui.md)
gives the interface's principles, and [architecture.md](architecture.md) owns process and
trust boundaries. **Only the local Week 1 client is implemented and accepted.** Everything marked
planned below needs its own implementation and acceptance evidence.

## One agent, several ways to use it

An agent is a contact: someone can give it work in duang and come back to the result. The creator
can use it locally, connect their own online instance, give someone the Agent (their own copy) or
invite someone to use that instance. These are different outcomes, not four modes of one global switch.
Slack, Feishu, Telegram and other FastAgent channels are additional entrances to an online agent;
duang is the full native workbench for long work and follow-up.

The objects are FastAgent's agent model ([fastagent#684](https://github.com/fastagent-sh/fastagent/issues/684)),
seen as a person using duang:

| Object | Owner and meaning |
|---|---|
| Agent | The definition: model, harness (`SYSTEM.md`, `APPEND_SYSTEM.md`, skills, tools, schedules, `fastagent.config.ts`) and the contexts it declares, in a directory of its own that is also its working directory. Someone given the Agent gets their own copy, not a live pointer. |
| Context | A directory the agent **works on** or **knows** (read-only): a project, a folder, a repository. Several agents can share one; it belongs to its project, not to any agent. Its type (local folder, local folder copied to a host, GitHub repository) says how it reaches an instance elsewhere. |
| Instance | One Agent running in one place, on this Mac or on a host: its conversations, credentials and what it fetched. duang shows an instance as a contact. One owned Agent can have a local and an online instance. |
| Conversation | A FastAgent session, owned by its instance. Local, online, personal and group conversations do not merge automatically. |
| Run | One turn of work. Accepted, running, settled and unknown-after-disconnect are different conditions; stopping does not undo completed tool work. |
| Invitation | Access to an existing online instance, not a copy of the Agent or a right to read everyone else's sessions. It can be revoked. |

There is no second durable transcript in duang. A shared Agent is not shared conversation memory. Shared knowledge, if declared by the agent, must be a deliberate input with its own
access boundary, not scraped from other people's chats.

## The workbench

The shipped view is a 320px agent roster and a reading column, with the open agent's conversations
in a list under the conversation header. The renderer currently
shows local agents only; the layout below is the intended extension, **not a screenshot of shipped
functionality**.

```text
┌ contacts and my work ─────┬ conversation / result ────────────────────┐
│ My agents                 │ agent · location · connection              │
│   local · online           │                                             │
│ Shared with me            │ task · live work · outcome                  │
│   online contact           │                                             │
│   my conversations         │ composer · continue / stop                 │
└───────────────────────────┴─────────────────────────────────────────────┘
                         details open only when needed
```

Conversations stay under their agent: the roster lists contacts, and each agent's conversations
open from its header. The roster distinguishes **mine** from
**shared with me**, and labels each agent's location; it never offers a global `Local | Cloud`
switch, which cannot represent an owner using both locations while also talking to a visitor's
agent. Current selection, drafts and late events remain attached to the originating agent,
location and conversation. A visitor sees only their own authorized conversations; a channel group
is neither their private chat nor the owner's private chat.

The central surface starts with what the agent can do, then becomes a readable record of the task:
what was asked, what is running, what finished, what failed and what to do next. "What failed" is
the run's outcome and anything the agent says went wrong, not each tool call: an agent reads its own
failed calls and carries on, so a failed step it recovered from asks nothing of the person and is not
called out when its work is folded; it still reads `failed` when opened. A call that never finished
(stopped, or cut off with its runtime) is not a recovered step, and folded work says it. Tool details stay
expandable; a long trace must not obscure the result. On reconnect, read runtime-owned state and
history rather than replaying an accepted send. A lost connection is **unknown execution status**
until the runtime can answer, not an automatic failure or success.

An optional detail surface serves the question at hand. A local owner can inspect the **actually
loaded** model, skills, tools, schedules and contexts where FastAgent exposes them, plus relevant
read-only files and diffs from the agent's directory and its contexts. If a field is unavailable, say so rather than infer runtime
state from a filename. The same surface on an owned online agent shows its published version,
connection, schedules and their recorded outcomes. An invited contact does not expose the owner's
files, secrets or hosting controls. No in-app code editor or general remote filesystem browser.

Schedules belong on an owner's online agent even if that agent has never been shared. A schedule
(`schedules/<name>.md`: a cron, a timezone and a prompt) continues one session, `schedule:<name>`, which
shows what each run said. Whether a fire completed, failed, was skipped or was interrupted is the host's fire
history, **only as the host reports it**, never read off the session. FastAgent has no remote route for an
instance's schedules or their fire history yet; until it has, a remote outcome is unavailable
([architecture](architecture.md#online-execution-and-schedules)). A local preview must not imply that a
schedule will fire after the laptop is turned off. Showing an exact next run or a success badge requires an
authoritative clock/outcome source, not a guessed timer.

## Settings: model providers and network (stage 1; network and the first providers version shipped)

The first run must not require a terminal, and someone given an Agent must be able to add their own
credentials. Settings open in the content area (the App menu's Settings… `⌘,`, or the Settings
row at the foot of the sidebar, or the model picker's empty-state **Connect a provider**); the sidebar stays visible so running work remains in view. One page, two groups, no
empty categories: Model providers, then Network.

**Model providers.** The goal: on a new machine, from installing duang to the first answer
without opening a terminal. It serves the owner on a new machine and, above all, someone given an
Agent, who brings their own credentials and need not install developer tools.

*Connect a provider* starts with the provider (Anthropic, OpenAI, GitHub Copilot, …), then asks how
to connect when there is more than one way: **Subscription** (OAuth: Claude Pro/Max, ChatGPT,
Copilot and the other flows FastAgent supports, signed in in the system browser) or **API key**
(verified once when saved, sent only to that provider's own endpoint). A provider with one way goes
straight into it. The list is FastAgent's `loginOptions()`, grouped by provider id and named as
pi names each provider; duang adds no names or groupings of its own (`OpenAI` offers both Sign in
with ChatGPT and an API key). The one exception is a provider pi keeps only for old logins:
`openai-codex`, ChatGPT through chatgpt.com, which pi replaced with Sign in with ChatGPT on `openai`.
duang does not offer it to connect, lists none of its models, and nothing runs on it: a send on it, from
an agent default or a conversation's own record, is refused and opens the picker until another model is
chosen. A login for it already in duang's file is left there, unused. Common providers come first
and the list can be filtered, since pi offers about forty.

A *Connected* list shows each provider with every source that authenticates it, Reconnect and
Disconnect. A provider-supplied environment variable (such as `ANTHROPIC_API_KEY`) is shown as a
source too, and cannot be removed from duang.

**duang's own credential file (shipped).** Connections are written to one file that only duang reads:
`auth.json` in the app's data directory, beside `agents.json` and `settings.json` (Electron's
`userData`: `~/Library/Application Support/duang/` on macOS, `%APPDATA%\duang\` on Windows,
`~/.config/duang/` on Linux). duang does not read the `fastagent` CLI's or pi's stores, and
`FASTAGENT_AUTH_PATH` no longer points it elsewhere. Sharing a file, or copying a login between
files, puts one OAuth grant in two places: some providers (Anthropic, OpenAI's ChatGPT sign-in) rotate the
refresh token on every refresh, so one copy's refresh silently invalidates the other. So a login made in a terminal is made again in
duang, as its own grant, and nothing duang connects, replaces or disconnects reaches the CLI. The
file holds one credential per provider: an API key replaces a subscription login for the same
provider, and the reverse, and duang says so before it happens.

Known limitation: the file is plain JSON with mode `0600`, as FastAgent writes it. Desktop apps
usually keep secrets in the OS keychain (VS Code, GitHub Desktop, Docker Desktop, Zed). FastAgent's
`credentialFile` reads and writes a file; since 0.26 a host may pass a `CredentialStore` of its own, so a
keychain-backed store is possible and not built ([fastagent#652](https://github.com/fastagent-sh/fastagent/issues/652)).

**Custom endpoints (after the first version).** Ollama, LM Studio or a gateway, as a provider in an
agent's `fastagent.config.ts` (`providers`, built with pi-ai's `createProvider`): name, API type, base URL,
optional key and the model ids. Ollama and LM Studio are prefills, not separate integrations. A relay in front of Anthropic or OpenAI is a custom endpoint
under its own provider id: duang never redirects a built-in provider's `baseUrl`, so a subscription
token or official key cannot be sent to a third party by a setting left behind from another
credential. An agent's own config can already declare providers, but 0.25 removed `models.json` and the
machine-level model catalog, so where duang would write endpoint definitions it adds is open again: a
config is code, and part of the Agent a copy carries.

**Network (shipped).** *Automatic* is the default and needs no setup: model and sign-in requests
follow the system proxy per request, including its bypass list and PAC rules, and pick up a VPN
client being switched on or off; a TUN-mode VPN needs nothing at all. *Manual* takes a type (HTTP,
HTTPS or SOCKS5), a server and a port; *Off* connects directly. The page shows the route currently in effect
and its source, and checks it: connected with its latency, or unreachable with the original error.
Proxy variables present when duang was launched from a terminal are an explicit route: *Automatic*
then uses them and stops following the system until relaunch, and the page says so. When a proxy is
in effect, the agent's own commands (`git`, `npm`, `curl`) receive one proxy in the standard
variables, as a terminal user would export it; per-host PAC rules and the system bypass list do not
reach them.

Reasoning effort is not a setting: it sits with the model in the composer's picker and applies to that
conversation, a new one before its first message included (a default per agent needs FastAgent to accept one). Per-agent material (tool secrets, inherited machine skills) belongs to the agent
detail view above. Appearance follows the system; shortcuts, notifications, a global default model
and accounts are not settings until a shipped feature needs them.

## Paths through the product

**Create an agent (planned with FastAgent's agent-directory release, [#133](https://github.com/fastagent-sh/duang/issues/133)).**
In duang an agent is created; there is no opening an arbitrary directory as an agent, and nothing is
scaffolded inside a project. An Agent made elsewhere (a clone, a copy someone gave) comes in through
stage 2's import, which is the only other way in; until then, creating is. *Create agent* asks for a name and the contexts, the way Codex creates a
project and attaches folders:

```text
┌ Create agent ──────────────────────────────────┐
│ [icon] Agent name                              │
│ Contexts                                       │
│ ┌────────────────────────────────────────────┐ │
│ │  Add a folder on this computer ▾   [+ Add] │ │
│ │  app   ~/code/app           Works on  ✕    │ │
│ │  handbook ~/docs/handbook   Knows     ✕    │ │
│ └────────────────────────────────────────────┘ │
│                          Cancel  [Create agent] │
└────────────────────────────────────────────────┘
```

Each context is a row: its name, where it is, **Works on** or **Knows**, and remove. The source menu
offers what the locked FastAgent version supports: a folder on this computer now, a GitHub repository
once FastAgent clones them. An agent with no context is valid; it works only in its own directory.
duang creates the agent's directory in `~/Agents/` (the folder is made with the first agent) and writes
its config from scratch, never rewriting a config someone edited, together with a `.gitignore` for
`.state/`, `.secrets/` and `.env`, both written only if absent: the directory is meant for git, and its
conversations and credentials must never be committed with it. The directory's name is the agent's
name made one safe path segment (letters, digits, `-` and `_`, the spelling FastAgent requires of a
name), with `-2`, `-3` added when it is taken; the name shown in duang is the name as typed, kept apart.
Renaming an agent changes the name shown, never its directory, as today. The folder is visible, like
`~/IdeaProjects`, because a person edits the harness, keeps it in git and gives it to someone; not under
`~/Library`, which hides it, nor `~/Documents`, which iCloud syncs along with the agent's `.secrets/`. The new agent has no default model, so its first
conversation asks for one. Its header then says what it works on (`works on app · knows handbook`)
rather than where its directory is. Removing an agent moves its directory, conversations included, to the
Trash after asking, because duang created that directory; its contexts are never touched. (Today,
removing an agent deletes its registry row and duang's instance of it, conversations included, after asking; the directory stays.)

**Daily local use (current foundation).** Connect a model provider in duang (into its own
credential file), add an agent (today, from a directory), choose a model, start work,
switch away, return to the real outcome, continue. Stage 1 strengthens the return-to-work flow,
visibility of the loaded Agent and relevant local change review, using real tasks before adding
compacting, forking or a complete file tree. The current client already covers the basic chat, history,
steering, stop, drafts and background navigation.

**Give someone the Agent (planned stage 2).** They get their own copy of the Agent; review exactly
what travels. Its harness travels; its contexts travel as their types allow: a GitHub repository by
reference (they need their own access), a local folder only if the owner chooses to include a copy of
it. No credentials, runtime state (`.state/`, `.secrets/`) or machine-specific paths. The recipient
has their own instance, connects their own provider and services, and has independent conversations
and schedule sessions. A successful export without an independent run on another machine is not acceptance.

**Use my own online agent (planned stage 3).** Connect an already running, protected endpoint; the
same owner can choose local for testing and online for ongoing work. Online history is separate.
With duang and the laptop closed, schedules must be observed firing through the remote runtime
and a real clock. Stage 3 tests this on a self-hosted instance; stage 4 makes deploying it easy on
duang cloud. Running the Agent elsewhere does not move a local conversation or OAuth subscription login.

**Invite to an online instance (planned stage 3).** An invitation adds a contact, not a copy of the Agent. A
visitor can start and return to their own conversations while the owner's desktop is closed. The
owner can revoke the invitation. First scope is access by possession of an individual, revocable
invitation; a promise to restrict it to a named person would need identity verification. The
endpoint must not expose the instance-wide `sessions.list()` to visitors.

**Host on duang cloud (planned stage 4).** Show the Agent snapshot, how each context reaches the host
(copied or cloned, or refused when it is a local folder not marked to copy), excluded files and
server-side credential requirements before publish. After publishing, return to the agent's
online conversation and schedules, with a clear live version and an update/stop path. Schedules
must actually fire with the laptop off; a sleeping VM without an external clock cannot keep that
promise. Add a channel used by real users without making a channel or invitation mandatory for
private scheduled work. Channel conversations keep their own identity and reply path; a private
message in duang does not automatically post back to the group.

**Group use (later).** Existing Slack/Feishu/Telegram groups already provide group conversation.
A duang-native group would need multiple human authors and shared-message semantics that the
current `SessionControl` entries do not provide. Build that contract only if external groups and
direct invitations fail a real need; do not silently treat one person's session as a group.

## Failure and safety rules

- Invalid local Agents, unreadable state, provider refusals and deployment failures keep the
  original diagnostic and an action the person can take. Never turn a failed list into an empty one.
- A remote timeout or disconnected stream never replays an accepted run or scheduled fire. On recovery,
  read state and history and report any outcome the runtime cannot prove as unknown.
- Hosting must not copy local credentials or conversations. The remote service has no built-in
  authentication in newer FastAgent; protect both control and invoke, isolate visitors' session
  access, and make invitations revocable before sharing an endpoint.
- On Fly or Railway, a schedule's clock requires a resident machine, or a verified external clock calling
  `POST /invoke` in place of the schedule; AgentCore wakes the container for it through EventBridge. Failed, skipped and
  interrupted fires are not successes; stop does not roll back tool effects.
- FastAgent does not yet sandbox the entire general agent process or guarantee exactly-once work.
  Do not promise arbitrary high-privilege tools are safe for untrusted visitors. No enterprise
  roles, administration suite, approval prompt system or compliance audit UI is planned.

## How we know it worked

A stage is accepted on evidence from real use, not on shipped screens or mocked tests. Measure:

- the time from creating an agent to using it daily;
- the time to the first schedule that succeeds while the owner's laptop is off;
- the time to the first person other than the owner successfully using a shared agent;
- whether owners and recipients come back to complete work.

Uptime alone does not prove an agent helped anyone, and there is no fixed install threshold yet. Do not
claim an online or shared flow has shipped based on local mock tests.

## Deliberately deferred

A built-in editor, general Git client, remote files, social discovery directory, native group chat,
web/mobile workbench and centralized transcript service are not prerequisites for local work,
giving someone an Agent, protected online contacts or optional hosting.
