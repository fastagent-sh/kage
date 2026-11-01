# Interaction

This is the behavior and failure contract. [Product design](design.md) owns the surfaces;
[architecture](architecture.md) owns state and trust boundaries. The local behavior below shipped
with Week 1 and subsequent UI work; later stages are **planned**, not implemented. See
[known limitations](../README.md#known-limitations) for what the local client does not do yet.

## Shipped local workbench

The window has a 240–320px sidebar of agent rows, and a transcript with its own floating header
and composer. There is no separate agent rail. Each agent row shows its name, two lines quoting the
newest output of the conversation a click on it would show, that output's time, and a count of
outcomes nobody has looked at yet. The quote streams while duang holds that conversation (on
screen, or running in the background); otherwise it is read once from the conversation's history
and again when the session list says it moved on, so a run driven from outside duang appears when
the list is next read. While one of its conversations runs the row says `working` in place of the
time, and its avatar's face shows what kind of work it is (docs/ui.md §3); a setup problem or an
unreadable list or history replaces the quote. Reading every row's list
at launch opens each agent's instance. A failed list read is shown on
that agent's row, not as an empty list. An agent's name can be changed from its row's context menu
or by double-clicking it; this renames duang's registry entry, never the directory. The window opens
at a size that fits the sidebar and the reading column, and reopens where it was left; a window whose
display is gone comes back on an attached one.

Clicking an agent row restores its last open conversation if still available, otherwise an active
run, then the most recent conversation (or a new one). The open agent's conversations are in a list
the header's list button, a round disc beside its info pill, shows and hides; it floats under the button, closes on a click outside or
Escape (without stopping a run), and closes when a conversation is chosen or started. Running and
drafted work stays attached to its originating agent and conversation when navigating.

Creating an agent asks for its name and any folders on this computer it should work on, and creates the agent in `~/Agents/<slug>/` (FastAgent's starter files, `context.json` / `context.local.json`, and a git repository). A refused declaration (duplicate folder name, nesting) is shown in FastAgent's words and creates nothing. An agent whose
directory is no longer there (moved, deleted, a drive not mounted) says so, with Retry and Remove from duang:
its row says `folder not found`. A folder that cannot be looked at (no
permission, macOS privacy controls) is not missing: it is a broken agent, in the system's own words.
An agent whose config does not load (FastAgent names the
config for a mistake in it, in a file it imports, or a package it needs) offers **Start a fresh config**: a
copy of the old file is kept beside it (`fastagent.config.ts.broken-20261003-144000`, which nothing loads, and
never written over an earlier copy), a new `export default {};` takes its place, and the agent opens asking
for a model. Main replaces only the config FastAgent said failed, inside the agent's folder; the window does
not name the file. Any other failure offers Retry and Reveal in Finder. A
broken agent shows its original failure with a way to retry, reveal or remove it; any agent's row menu
has Reveal in Finder, and the header shows the folders the agent works on (`works on app · handbook`, or its own folder when none are attached), a click on which reveals that folder. Removal moves the agent's directory in `~/Agents/` and duang's conversations with the agent (its instance) to the Trash, after asking, and leaves the folders it works on untouched. Removing an agent or replacing its config
is refused while one of its conversations is at work, including a send still being recorded; changing its model is not, since nothing is rebuilt.
A default model duang keeps for an agent that this computer's providers no longer offer (its provider was
disconnected, or its config no longer declares the model) does not stop the agent opening: the chip names it, the picker
opens with `<model> is no longer available` at its top, and a send on it is refused before anything is recorded; the model chosen there becomes
the default and, as any choice in the picker does, the open conversation's model, which the notice says. Other conversations keep the
models they recorded. Closed without a choice, it opens again the next time the agent is opened.
An agent with no default model opens like any other, on the conversation it was left on or its latest: a
conversation runs on the model it records. Only a conversation that records none (a new one, or one whose
model is no longer in the catalog) with no default to fall back on asks for one: the picker opens on it and
the composer says "pick a model to start"; the model chosen there runs that conversation. Closed without a
choice, the picker stays closed until another conversation is opened or the chip is pressed. A model change leaves the open conversation as it is: the transcript stays (the same rows, the same scroll position)
and only the chip and the effort track are read again. While it is made, the composer says "changing the model…", not that a conversation is opening.
The picker lists the models the open agent can run, as FastAgent reports them: pi's built-in providers and the ones the
agent's own config declares, each kept to providers with a credential here, in duang's credential file or in an
environment variable. Switching agents with the picker open reads the new agent's list. It
lists each model by the name it declares (its id when it declares none) with its context window
(`GPT-5.5  272K`). pi's catalog lists some models twice, the alias that follows the newest snapshot as
"… (latest)" and that snapshot under its date; that is one row, the alias (a snapshot a conversation runs on
stays listed, named with its date). "(latest)" is dropped from any name that stays unique in its provider
without it, and kept where it is what tells two rows apart. It shows the full `provider/id` on hover, searches both the name and the `provider/id`, groups
the models under their provider with the selected one first, and ends with the conversation's effort: a
track of the levels FastAgent reports the model supports (`info().models[].thinkingLevels`, lowest first). A model that does not reason
has one level and the picker says it has no effort setting. duang refuses a level the conversation's model lacks, because FastAgent would
clamp it when it calls the provider and the level shown would not be the level used. Moving a conversation to a model that lacks the level it had sends its effort back to the agent's for the same reason. A new conversation exists in FastAgent from the moment it is started, so effort and
model can be set before sending; it is listed as *New conversation* until its first message. A conversation with no model yet
has no track, so the picker says effort can be set once a model is chosen. A conversation never given a level follows the agent's
`thinkingLevel` and the track says `Agent default`; the chip names a level only once one is set on the conversation, and that level is the
open conversation's only. While a turn runs the chip is disabled with "Stop the turn to change the model or effort", so the
transcript's model and the one answering are never apart; the arrow keys move along the track
and write nothing, and Enter, Space or a click choose. A list of more than 60 models says how many it left out. The picker shows no credential path and
links to no provider page; with no model to list its one offer is **Connect a provider**, which
returns to the picker after connecting. It says no model is available rather than that nothing is
connected. Configuration is not a provider probe. FastAgent refreshes its model lists from pi.dev when
an agent is opened (at most every four hours, over the same proxy route as a model call) and keeps them in the
instance's state; a model released since is listed after the next open, and with pi.dev unreachable the lists last kept are used.
duang has no refresh control.
The model on a historical conversation can differ from the agent's default.

Settings open from the App menu's **Settings…** (`⌘,`) or the Settings row at the foot of the
sidebar, in place of the conversation; the sidebar stays, and choosing a conversation, `⌘N`, the
close control or Escape returns to it. Opening it again while it shows keeps it open. **Network** has three choices, saved to
`userData/settings.json` and applied at once to new requests (a running turn keeps its
connection). *Automatic* resolves the route for each request from the system, so switching a VPN
client on or off needs no action in duang, when duang was launched without proxy variables. If it
was launched from a terminal with `HTTPS_PROXY` or `ALL_PROXY` set, *Automatic* uses that, names
it as the source and does not follow system changes until duang is relaunched from the Dock or
Finder; *Manual* and *Off* still override it. *Manual* is a type (HTTP, HTTPS or SOCKS5), a
server and a port; choosing it with nothing saved applies nothing until **Use this proxy**, and each
field that cannot work says so (`Server is required`, `Port is a number from 1 to 65535`) and
nothing is saved. The chosen row shows the route model requests take now and checks it with one
request on opening and after every change: `connected · 320 ms` for any HTTP answer, or
`unreachable (ECONNREFUSED)` with the full error, naming the route, on hover; a refresh control
checks again. A route duang cannot take (a PAC answer such as SOCKS4) shows as `unsupported proxy
route` and fails model requests with that reason; if only the route for agent commands is
unusable, they get no proxy variables and the page says so in red. Neither stops duang from
starting or sending. Choices are applied one at a time in the order made. A launch proxy variable
with a user name or password (`http://user:pass@proxy:8080`) cannot be used, because duang cannot
authenticate to a proxy yet: *Automatic* then shows `unsupported proxy route` and every request
fails with that reason rather than the proxy's bare 407; relaunch without them, or choose *Manual*
or *Off*. Each choice group is one tab stop on its checked row; the arrow keys move the choice.
**Avatars** offers seven styles, each shown on the same four sample agents, and is saved to the same file;
choosing one redraws every avatar at once. Gaze is the default. An unreadable settings file leaves the
avatars in the default until it is fixed: main says so when it starts and the page says so when opened.
A model request through an unreachable proxy fails with whatever its provider SDK reports, often only a
connection error; duang never falls back to a direct connection, which may be blocked or may
bypass a route the person chose. A settings file that cannot be read is reported at launch and on
the page, with Reveal and Retry, and is never shown as or overwritten with the defaults; the
network follows the system proxy until it is fixed.

The conversation header's right edge is how full the conversation's context is (`context ▬ 12%`), and
only that: it is about this conversation and moves as it goes. It is always there: a new conversation
has no context to report until its first answer, and says `–`. On hover or focus a table adds, for a Claude subscription login of the conversation's own provider, each of
the plan's windows: its share used, its reset time, and for windows of a day or more the pace against
the clock (`▼` under, `▲` over), then the context as `45% of 1.0M`. Sign in with ChatGPT has no windows duang can read: the table says
`ChatGPT plan · View usage`, which opens chatgpt.com's usage page in the browser, as does the provider's
row in Settings. An API key has no plan windows, so the table is the context alone. Opening a conversation, changing its provider and a run starting or ending ask again; main
answers from a three-minute cache, since Anthropic's route answers 429 when polled. A failed read
shows no plan windows, never a stale percentage: the numbers are a glance, and a failure there is
not something to act on. The context is FastAgent's, once it reports it
([fastagent#608](https://github.com/fastagent-sh/fastagent/issues/608)).

A new conversation is made in FastAgent when it is started (the agent's blank one is reused when it has one), so
it is selectable at once and listed as *New conversation* until something is said in it. Selection reads FastAgent
history; the client does not save a second transcript. A conversation's row is quoted from the newest message the person sent in
it, read when the list is, so it follows the conversation as it goes; one with nothing the person said in view is `Conversation`. FastAgent cannot rename or delete a session,
and duang does not offer either. The current local view keeps unsent text with its conversation
across navigation and application restart. A failed draft save shows a warning with its original error
while editing remains available; the next state publication retries the unsaved value. An invalid stored
value is preserved in `duang.drafts.unreadable` before new drafts may replace it. If reading or preserving
that value fails, its original key stays untouched until a reload with working storage. Copy unsent text
before closing or reloading a window that reports a storage problem. A send rejected before admission remains a draft, and a refusal is said each time, even when an
earlier message got the same one. A run starts only on a model the picker would offer to the agent: a
conversation whose provider was disconnected, or recorded on a route duang no longer runs, refuses a send,
and since choosing a model is the way on, the model picker opens by itself on it: a line at its top says
*anthropic isn't connected* (or that the model is not available with the connection that is), "Choose another
model to send your message", with **Connect anthropic** when the provider is not connected at all, which
returns to the picker, where the line is gone once the model is in the list (it says nothing while the
list loads). The message stays in the composer, the chip is marked until a model is chosen, and
nothing is written into the conversation, rather than failing inside the engine with its command-line advice. A failed run may already have performed tool work. Stop does not roll back completed work or promise
to cancel a non-cancellable tool. Stop pressed while a send is still on its way to the runtime keeps it
from starting a run, and the message returns to the draft without a note; Stop pressed as a run ends
says nothing, since the run's own ending is already in the transcript.
Problems are said as ui.md §9b lays out: what it means, what to do, the way on, and the original words
verbatim but folded. An answer that did not end normally says so in the transcript, live and when the
conversation is read back from history, including runs no window watched: a failed answer gets a card
titled by what the reason means (*The provider did not accept the sign-in* with **Sign in to OpenAI again** for a
401, which opens Settings on that provider's ways to connect and returns to the conversation once connected;
*Could not reach the provider* with **Network settings**, which opens Settings at the proxy, for a connection error; *The provider is limiting
requests* or *had a problem* with **Use another model**, which opens the picker, for a 429 or a 5xx; *The run stopped with
an error* for a reason nothing recognises), below any partial text it streamed; `run stopped` under a stopped one (live and read back alike, wherever the stop
landed), one live line
while pi waits out its own retries, which becomes `retried 2 times: …` once the run goes on and is gone if
the run ends there, since its ending says how (`retrying 2/3: the provider had a problem`, or the reason's own first line when nothing recognises it, such
as `retrying 1/3: Request timed out`; never "the run stopped", since it goes on; the provider's words in full on
hover) and,
read back, the same `retried 2 times: …`, and `answer cut off at the model's output limit` for one that reached the limit (the run
goes on; a call that answer made is shown failed). A conversation that ends on a failed turn (a run that took
the message and then failed) offers Retry under the failure while nothing runs: it sends that message again
as a new turn, leaving the failure and whatever the failed run did in the transcript. A failure that is a ChatGPT plan's usage limit (`subscription_sharing_usage_limit_exceeded`) also offers View usage, which opens that page. A run that was steered is
retried with its last message, the one it was answering; the earlier ones already entered the conversation.
When the failed run had used tools no answer concluded (a steered run's included), Retry first asks, because
the agent may repeat that work. Watched live, the question counts every tool since the run started; read
back, only those after the last answer or tool batch that ended the work, since history does not record
where a run began. They differ only when a steer carried a run past such an answer: live asks, read back
does not. Live errs toward asking. Nothing is retried without that click, and a stopped run is not offered again.
Read back from history, the message is the one the runtime recorded, so a slash command is resent expanded. A conversation that is not running but whose history stops partway through a turn (on the message, on a
tool's result, or on calls that never ran) was cut with nothing recorded, because duang or the machine
stopped mid-run: it says *This run was cut short* and offers Retry the same way. An agent's row
reads the conversation's state with its history, so a run still going (after a window reload) is not called cut;
A run whose last tool batch ended it on purpose
(every call answering the last answer returned pi's `terminate`, which its `tool` entries record) also stops on
a tool's result, and is not called cut. 
How the message ended, which no entry records, is read from FastAgent's message: a failure that left no answer entry
is said as the failure (with FastAgent's own code deciding what to offer, such as signing in for `auth_required`), a
cancelled one as `run stopped`, and a message that never entered the conversation returns to the composer, saying why when it failed.

The composer is one row: the field with the model chip inside its right end, and one round button
that is the next action: Send, disabled and saying why while the draft is empty (whitespace is
empty); Stop while a run is live and nothing is typed; Steer while it is live and something is.
The model chip moves under the text once the draft is more than one line. It sends with Enter, inserts a newline with Shift+Enter and leaves IME composition to
the input method. `⌘N` or the header's conversation list's New conversation action starts a conversation in the open
agent and focuses its composer when ready; Escape dismisses an active overlay before it can stop a
run. While a run is live the composer steers it (the round button is Stop while the field is empty and Steer once it holds text; Esc always stops); FastAgent decides the actual admission. A sent message waits below the output until its `user` entry arrives, and is placed there; one that ends without entering returns to the draft. Messages sent from another window or by a channel are placed when they enter, and a message queued elsewhere is not shown until then. A refused send is not shown as delivered. The roster is one tab stop with arrow
navigation, and the transcript is focusable. While a run waits on the model and nothing has come from it for 30 seconds (a steer of the person's own does not count), its status line adds `no output for 45s`: a thinking model can be that quiet and be fine, so it is said plainly, and a running tool, which has its own clock, does not add it. A tool call reopened from history shows its arguments, as it did live. A long conversation opened at its latest line shows that end at once and draws the rest above it over the next
moments, while the view stays where it is; one returning to a place it was left at draws from that place the same way. Scrolling up suspends tail-follow; a control returns
to the latest turn. A conversation is opened at its latest turn, or, when it was left scrolled up, where it was
left, through Settings or another agent and back (for the window's life, not across launches). The place is the line
at the top of the view, at the same height in it, counted within its turn from the person's message: lines drawn
above it and output the run added while the person was away do not move it, and a card that was expanded comes back
folded (a place inside one returns to its top). A conversation left idle is read back from history on return, which
does not have the lines only this window showed (a "Not sent" note); a place later in the same turn as one
of them comes back one line off.
The place is held while the layout settles and while output goes on arriving, until the person scrolls. While the history of a conversation the runtime already
has is being read (and while an agent opens, until it is known to have none), the pane is empty with the composer in
place: the new-conversation page is for a conversation nobody has spoken in, and is not shown for the moment
before the real one arrives. A view that was at the latest turn stays there while its
content grows by itself, and choosing the conversation that is already open rebuilds nothing. A failed action
that belongs to no conversation (adding, renaming, revealing or removing an agent) is said in a strip that
floats under the header, titled by the action (*The agent was not renamed*), with Dismiss, never written into whichever conversation is open; one about a conversation (a refused send, say) is said in that conversation when the window holds it, else in the same strip,
titled by the action; an agent's row only ever says that its list could not be read.
Only a registry that cannot be read shows the unreadable-registry page. A stream that finishes by itself is listened to again
by itself once, from the last entry the window holds, unless a send in it is still answering (a refused one
puts its words back in the composer, which reopening would replace); one that ends again within 30 seconds,
one duang ended (the agent was removed) and one that failed say so in the same strip, with Reconnect
(*This conversation stopped updating*, or *The live connection to this conversation was lost*), rather than
silently leaving a run on screen forever; the strip floats, so the transcript does not move for it.

Closing the window does not stop main-process work. Quitting with active local work warns that it
will stop the run; local work does not continue when the app and machine stop. Quit anyway records a
stop for each running conversation, as Stop does, so its history says it was stopped (`run stopped` when
reopened) and nothing answers the message at the next launch, then closes the agents, which gives the
work up to three seconds to end; a tool that cannot be cancelled is cut when the app exits. Quitting
again while it waits quits at once, and a message sent while it waits is refused (`duang is quitting: the message was
not sent`) and stays in the draft. A window whose renderer crashes or is killed is
reloaded and reopens what it showed; runs in progress keep going in main. After a third crash within a
minute (counted for the app, not per window) it is not reloaded onto the same conversation in a loop: a
dialog says so, and **Open on a New Conversation** opens the window on a new conversation of that agent, the
one it was showing still in the list (or **Close Window**); that choice holds across a reload or restart until
another conversation is opened. A conversation that cannot be drawn shows the
error in its place, with Try again, which reads it again from history, while the sidebar and composer stay usable;
an error anywhere else in the window shows it with Reload and Open on a New Conversation. Local channels
and schedules are not started by duang. The current client has no online contacts or share UI.

## Planned: daily local use and inspecting the loaded Agent (stage 1)

Walk a real task through find → send → switch away → return to result → continue before adding
controls. A local owner may open a read-only detail view for the Agent actually loaded by
FastAgent, its contexts and relevant files/diffs; if runtime discovery is unavailable, say so. A local schedule
shown in this view is **declared**, not guaranteed to run while the app is closed. Compacting and
branching are conditional on demonstrated long-conversation needs, not a checklist of Pi commands.

## Connecting model providers (stage 1, first version shipped)

The first version ([#84](https://github.com/fastagent-sh/duang/issues/84)) covers subscription
sign-in and API keys for pi's built-in providers, disconnecting, and the picker's way in. Custom endpoints come after it
([design](design.md)). Reasoning effort ([#83](https://github.com/fastagent-sh/duang/issues/83)) is set in
the model picker, per conversation.

**Model picker.** The list is already the open agent's, custom endpoints included (#59). With
no model to list it says so (naming a ChatGPT sign-in to reconnect as one cause) and offers **Connect a provider**,
which opens Settings. Otherwise, providers are managed from the Settings row in the sidebar. Returning from a successful connection reopens the picker without
choosing a model for the person.

**Choosing.** Connecting happens in place, in the provider's own row of Settings; there is no
dialog. Providers not yet connected are listed by pi's names, common ones first, the rest behind
*More providers*, all searchable (Escape in a non-empty search clears it before it leaves
Settings). Opening a row shows how to connect it (subscription or API key) side by side, even when
there is only one way, so nothing starts on a click that only meant to look. A connected provider
opens the same way from its row's menu (*Reconnect…*), saying first that connecting replaces the
credential it holds. Arriving from the model picker scrolls to the providers to add.

**Connecting.** The flow is driven by FastAgent's `login`
([fastagent#602](https://github.com/fastagent-sh/fastagent/issues/602)) and rendered by the kind
of step it asks for, never by per-provider screens: a browser sign-in opens the system browser and
offers *Open again* and *Copy link*, with a folded field for pasting a code or redirect URL when
the browser is on another device (the field disappears if the browser callback wins); a device code
is shown large with *Copy* and a link to the verification page, counting down if it expires; a key
is shown as typed, stays in its field while it is checked (selected for fixing if refused) and is
never stored in drafts; a choice is a list.
A key is verified once: a rejected key (HTTP 401) is asked for again with the provider's reason; a
key that could not be verified is saved with that warning. There is no separate Cancel: collapsing
the row by its header, opening another provider (one row is open at a time, and none is ever
locked), leaving Settings (Escape) or closing the window ends the flow and writes nothing, with no
error shown. Any other failure (port in use, token
exchange, network) shows the original message with *Try again* and *Back*.

**An unreadable file.** A missing `auth.json` is nothing connected yet. One that cannot be read or
parsed is shown with its original error and path: in the providers list with Reveal and Retry, in
the model picker with Retry. It is never shown as "nothing connected", and connecting or
disconnecting refuses to write over it (FastAgent's store will not overwrite a corrupt file).

**Connected.** Success closes the row, and the provider appears in the connected list with a brief
`connected` mark (or `saved · key not checked` when the key could not be verified). A subscription
row there shows its plan windows once they are read and nothing when they are not. If Settings was
opened from the picker, the picker comes back.

**Disconnecting** removes the provider's credential from duang's file after a confirmation, asked
in the row itself. It
never reaches the CLI's or pi's stores. If an environment variable also supplies the provider, the
confirmation names it and says requests continue with it; otherwise it says conversations using the
provider fail on their next request with the provider's own error.

## Planned: give someone the Agent (stage 2)

Giving someone an Agent previews exactly what travels: its harness, and each context as its type
allows (a repository by reference, a local folder only as a copy the owner chooses), and explicitly
excludes secrets, runtime state, machine paths and anything outside the Agent and the chosen
contexts. The recipient gets their own copy, connects their own credentials and can change it. A
failed import leaves the original untouched. Never present it as continued access to the author's
instance, or imply that it also copies their conversations.

## Planned: use an online agent (stage 3)

An owned agent may have a local test location and a separate online location; select the location
on that contact, not with a global app switch. The owner can also add a protected self-hosted instance
whose Agent is not on this machine. An invited agent appears under "shared with me" and exposes only the
visitor's authorized conversations. Do not expose the author's files, model credentials or owner
controls. The private online conversation is distinct from channel-group history.

An invitation is individually revocable. If access means possession of a link, say "anyone with
this link"; do not promise a named person until identity is actually verified. Losing connection
keeps unsent text, shows the endpoint's real error and marks the ongoing work as unknown until
state and entries can be read. Retry reconnects **observation**, never blindly resends accepted
tool work. Calls refused by `capabilities()` are disabled with their reason rather than failing
silently. On return, read runtime history; if partial history lacks tool args or outcomes, never
present it as a complete replay.

## Planned: hosted online work and schedules (stage 4)

Before publishing, review the versioned Agent snapshot, how each context reaches the host, excluded
files, server-side model credentials, schedules and running-host cost. Publishing an agent with no channel or invite
is valid: the owner may need it only for private conversation or timed work. Keep local OAuth
credentials and local conversations on the laptop. A remote model choice is governed by the remote
runtime, not by the local credential picker.

After publish, the owner can see which version of the Agent is live, update or stop it, and see how each
schedule's fires ended, from the host's fire history, with what each run said in its `schedule:<name>` session. A schedule must actually fire while the desktop
and laptop are closed. Show
failed, skipped or interrupted runs as such; if the host cannot report the outcome, say it is
unknown. Do not invent a "next run" or "done" from a declaration alone. A channel is an optional
additional entrance: a private message in duang does not post into a Slack/Feishu/Telegram group.
An online agent belongs to its host when the client window closes.

## Failures everywhere

Keep the original diagnostic at the affected agent, conversation, schedule or publish action, with
the action that can actually remedy it. An unreadable session list is not an empty one; a refused
send is not delivery; an accepted run is not a successful outcome. A failed update must not be
shown as a newly published version. Do not treat a lost network connection as grounds to replay a
run or scheduled fire. Preserve context across navigation without attributing a late event to a different
contact, location, session or subscription.
