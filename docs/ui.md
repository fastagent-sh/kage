# Interface design

The principles behind kage's interface and the reason for each. It does not restate sizes, colours or
layouts: the code is the measure, `npm run shots` shows the result in both colour modes, and the component
sheet at `#gallery` shows every control (§6b). [design.md](design.md) owns product paths and
[interaction.md](interaction.md) owns behaviour; this document says how they should read.

## 0. What the product asks of the interface

1. **The person works with an agent they created or were invited to use.** Creators also need to
   inspect the definition and its local changes; recipients mainly give work and read results.
2. **The client is where work happens and where people return to its outcome.** Local testing,
   online work and diagnosis should feel continuous without pretending their histories are one.
3. **The two sides of a conversation are asymmetric.** A task or correction is usually short; the
   agent's answer and tool work may be long and structured.
4. **Work runs in the background, in parallel, for a long time.** You come back to it as often as you
   watch it, and you need to see which of several conversations is alive.
5. **The transcript is the work record.** Later read-only details may show local files and an
   owner's schedules, but do not duplicate the runtime's conversation history.

Anything that fragments the agent's output (bubbles, cards per paragraph, decoration) fights facts 3
and 5. Anything that hides parallel work to keep a list tidy fights fact 4.

## 1. Three principles

**An agent is a contact; a conversation is a topic.** The default view is a roster of who you work
with and what they last worked on. Several conversations per agent are real and never hidden, but
they live one level down, in the open agent's conversation list, so the roster stays a list of
contacts.

**Navigation stays quiet; work stays readable.** The sidebar is a flat surface, the header floats
without a frame, and the composer has a clear boundary. The transcript stays opaque.

**Say status only when it costs the person something.** Not every state deserves an indicator (§9).

## 2. References

Borrowing a solution means borrowing its premise, so each reference is kept only where its premise
holds here.

- **Grok Bot**: agents as the primary object rather than a chat history; system events sharing one
  timeline with the conversation; removing controls rather than adding them. Refused: bubbles on both
  sides (their heavy work lives in a separate panel; ours is the transcript, fact 5), a character that
  performs a lifecycle (ours keeps its drawing and lets only its face follow the work), and pin and
  hide (a roster of fifty, not the few agents you use).
- **Claude Code desktop**: parallel sessions stay visible, because parallel work is the normal case
  (fact 4).
- **Telegram** (open source, so measured rather than guessed): the proportions of a contact row, a
  shuffled step through avatar colours so neighbours never share a hue, every interactive colour
  defined as a set of roles, floating chrome over continuous content, and the unread pill. Refused: one
  thread per contact, ripple on press (a Material gesture no macOS app makes), and unread-first
  ordering (an agent list is ordered by what is happening now).
- **Codex**: the model chip and its picker, with effort beside the model.
- **[Cindy](https://github.com/makecindy/cindy)**: quiet navigation, neutral reading typography and
  flat content surfaces. Keep kage's Agent roster rather than its mixed task/project navigation.
- **Carbon, HPE, WCAG 1.4.1**: the status tiers in §9.
- **macOS**: translucency stays in navigation; reading surfaces are not glass.

## 3. Structure

The sidebar lists agents beside the open agent's conversation. Agent details is not a column: like a
Telegram profile it takes the conversation's place, opened from the avatar or name in the header and
left with the round back button or Escape, which returns focus to the opener. It reads top to bottom: a
large avatar and name, a row of actions (message, show folder, remove), an info card, then the folders,
skills, tools and variables. At very narrow layout widths, including increased zoom, the roster opens
from an **Agents** button. Future contact surfaces are specified in
[design.md](design.md#the-workbench), not reserved as chrome here.

**Sidebar rows are agents, and only agents.** Listing each agent's conversations under it made the
column a tree of folders, and an agent read as a directory of chats rather than as someone you work
with. A row is a name over a quote of the newest output of the conversation it speaks for (the one a
click would show), with the time of what it quotes and the count of unseen outcomes in a fixed
right-hand column, so a count is never a line away from the words it belongs to. While a run is going
the row says `working` in the time's place and its quote is the work itself; a setup problem takes the
quote's place, since there is nothing to quote. A quote is presentation, never stored: the transcript
stays the runtime's.

**The header names the agent and where it lives, not the conversation.** A person talking to a contact
is not asked to think about sessions; conversation titles are in the conversation list, which hangs
from the header's one button as a native popover. The header and composer align with the reading column,
so navigation, the last line and the next input share one axis.

**Presence is told at two levels.** The avatar answers *is this agent busy at all*, the conversation
list answers *which one*. Neither repeats the other, and neither is colour or motion alone (§9).

**An avatar has three layers, kept apart.** The *drawing* is who the agent is and never changes with
state. The *face* follows what the agent is doing, one face at a time by how much it asks of the
person (setup problems outrank work in progress, then unseen outcomes, then idle). The *ring* is presence.
Motion is small, continuous only while an agent works, and an outcome plays once, when it lands;
under reduced motion each face keeps its pose so the states stay apart.

**Navigation leaves room for the work.** The sidebar is a flat, inset surface without a decorative
border or shadow. The header has neither; the composer keeps its outline. Both float over the
transcript, with veiled edges so scrolling text passes beneath them. In the compact layout the header
and composer take their own rows instead, leaving the transcript a scrollable reading area. The
roster then opens as an overlay and keeps its boundary and shadow to separate it from the content.

**The composer starts as one row**: the field, with what belongs to the next message (the model chip)
inside its right end, and one round button that is the next action. The model moves below the text
before it leaves too little writing space. In the compact layout a long draft scrolls inside a
viewport-bounded field, rounded down to complete text lines, so the reading area and action stay reachable.
There is no attach or voice button until either works: a control that can only say it is not there yet is furniture.

Not included until a real roster stops being readable: pinning, hiding, archiving, folders, a global
activity row, a third column. Removal is offered where a problem explains it, not one slip
away from opening an agent.

## 4. Colour

oklch, two modes, following the system. Neutrals carry almost no chroma. In dark mode the transcript's
canvas is the darkest layer and every panel sits above it, so a panel reads as lifted rather than as
a hole; light mode is its own set, a warm reading canvas with a deeper sidebar, not dark mirrored.
Every surface is opaque: there is nothing behind the window worth showing through it.

Violet is for selection and action, never a tint on every surface. Accent as text and accent as a
surface are separate tokens: text against the page needs to be light in dark mode, while a fill under
white text must stay dark enough to read in both, so fills do not change between modes.

Every interactive role is a set of tokens (`bg`, `bg-over`, `bg-active`; `text`, `muted`,
`fill-fg`), and a component picks a role: it never computes a hover colour itself.

An avatar's colour is the agent's own number from the registry, kept for its life, mapped onto a
palette chosen to be told apart at a glance and stepped so agents added one after another land far
apart. Every avatar wears near-black initials: white fails contrast on any colour bright enough to be
cheerful. `avatar-colours.test.ts` holds the palette to those rules.

## 5. Typography

**Reading and controls use the system face.** Answers, sent messages, drafts and roster previews
share the native typeface with controls and status text. Chinese uses the system's own face; it is
never forced into the monospace family.

**Identity keeps its rounded face.** Agent names and conversation labels retain `Prose`: Nunito for
Latin and Resource Han Rounded for Chinese, sized to match each other. Avatars keep their existing
lettering. Personality stays with the contacts while long answers remain visually quiet.

**One monospace everywhere**, Maple Mono, so a command in an answer looks like the command that ran.

**Chinese is a first-class case.** Reading text takes one line height that suits Chinese and is
slightly airy for English, since nothing marks a message's script and a detector would be a second
source of truth about the transcript. Mixed Chinese and Latin get the browser's automatic spacing; code and paths opt
out to keep their columns.

**What you write, what you sent and what the agent answered are one voice**, a reading size above the
navigation; the work that produced it reads as an aside, smaller. Emphasis is weight, never hue, and
body text is never coloured.

The chrome's size scale is 11, 12, 13, 15 and 22, with mono half a step up (12.5) because its
x-height is smaller. Nothing else is drawn at a half step: it is invisible, and only stops two things
that should match from matching. `tokens.test.ts` fails on any other size.

## 6. Icons

Phosphor, one weight for the whole app: Bold, which sits beside text the way SF Symbols' semibold
does, where Regular reads as a hairline. Emphasis is colour, not weight. Every icon has a label;
icon-only controls exist only where the symbol is universal (send, stop, close).

## 6b. Controls

Four kinds of button and no fifth: `primary`, at most once on a screen; `secondary` for an
alternative; `ghost` inside a row, header or composer; `danger`, quiet until the pointer is on it,
because these sit on screen all day. `loud` fills a kind for the one control that must be found
instantly, Stop. Size decides text size, so nothing a call site passes can contradict the component.

**A disabled control says why.** `disabled` takes the reason, not a boolean, and the control stays
focusable (`aria-disabled`), because a reason nobody can reach by keyboard is not a reason.

Popovers share one surface, whether they take focus (the model picker) or not (the `/` list).

`#gallery` renders every control with the app's own components; `npm run shots` captures it. It is
read once at load, so a `#gallery` link in an answer cannot unmount a running app.

## 7. Space, radius, elevation

Spacing groups rather than separates: things that belong together sit closer than things that do
not, and one gap for every pair makes nothing belong together. Two radius tokens, concentric where
they nest; a bubble's trailing corner and inline code are the only 4, which is what makes a bubble
read as speech. `tokens.test.ts` rejects arbitrary radii. Only overlays cast a shadow; docked
navigation and reading content stay flat. No divider between sidebar and conversation: the change
of surface is the separation. Code and expanded tools use neutral surfaces; table headings use
weight and a hairline rather than a filled band.

## 8. Message rendering

**What you send is a bubble.** Your turns are short, and their job is to be findable when you scroll
back: a small, distinct shape is a good anchor.

**What the agent produces is a document**: no bubble, full markdown in one reading column that the
composer shares, at a measure where a Chinese line is still easy to return from. Wrapping commands,
plans and reports in speech balloons fragments a record that needs to be scanned (facts 3 and 5).

- **A stretch of work is one line** that says what kind of work it was (`thought 6s, read 4 files, ran
  1 command`), opening into the calls. Twenty lines for twenty file reads said nothing the person
  needed. A failed call is not called out on the line, because the agent reads its own failures and
  goes on; a call that never finished is (`1 stopped`), because nothing else says the work was cut.
- **The live end of a run says what it is doing, once**: one plain line with the step and what it is
  on, for the whole run, not only its silences. Where the newest line already is that step, that line
  carries it; a model gone quiet is said, so a long silence does not look stuck.
- **A tool call is a line, and a card once opened.** Closed, it is as light as the thought beside it;
  the surface arrives with the output it has to hold. Output folds to its head; a shape that cannot be
  unwrapped keeps its JSON, because a result nobody can see is worse than an ugly one. A time is shown
  only for a call this window watched: history does not record how long a call ran.
- **Thinking** is one muted line, the line it is on, opening into the thought. A line still being
  written reads as a fragment, so the last complete one is shown.
- **A fact about the session is one quiet line**; a problem the person may have to act on is a card
  (§9b).
- **A message is placed where FastAgent says it entered**, not where it was sent: a steer is read at
  the run's next turn boundary. Until then it waits below the output, saying `sending` or `queued`. A
  steered message is marked as such only live: the history does not say it, and FastAgent declined to
  record it ([fastagent#595](https://github.com/fastagent-sh/fastagent/issues/595)) because its
  position says it.
- **A settled answer ends with when it landed and a way to copy it**, only where it ends a turn.
- **Space is decided by the pair.** Asides in a row (a call, a thought, a quiet line, the live line)
  close up, because they are one activity; a change of speaker earns the full step. One gap for every
  pair turned a work log into a sparse list.
- **A day boundary is a line of its own**: reading yesterday's run is the normal case.

## 9. Status

Three tiers, decided by what the person has to do about it.

| Tier | States | How it is shown |
|---|---|---|
| **Needs a decision** | broken, folder not found, failed, stopped, refused | Text always, plus icon or shape. Colour is the third signal, never the only one. |
| **Reassurance only** | working and the steps of a run | The avatar's ring and face, the word on the rows, and the live line at the transcript's end. |
| **Nothing to do** | ready, done once seen | Nothing. A trace where nine calls in ten say `done` is how the one that failed gets lost. |

One vocabulary everywhere, so a condition is never `working` in one place and `running` in another:

`working` · `thinking` · `running` · `reading` · `searching` · `editing` · `fetching` · `answering` · `starting` · `done` · `failed` · `stopped` · `refused` · `unsent` ·
`folder not found` · `broken`

Copy says what something means for the person, never how kage is built: "Saved on this computer", not
the name of a credential store. An agent's own files, which its author names, and original error text,
kept verbatim, are the exceptions.

**An outcome you were not there for is a decision, not reassurance.** It is the one mark that has to
be seen from across the room, so it is Telegram's unread pill, and the dock carries the total. Looking
at the conversation spends it; a run you stopped yourself leaves none. It lives in memory: it is about
this window's attention, and the transcript stays the only record.

`refused` and `failed` stay separate: a refused message never ran and is still the person's to edit; a
failed run ran, and its effects may exist. A person's own Stop is `stopped`, never `failed`, which
would blame the run for their decision.

## 9b. Problems

A problem is said for the person, not for the program that noticed it, in this order:

1. **What it means**, as a title in the person's words, from the reason's own markers, conservatively:
   a reason nothing recognises gets a plain title, never a guess (`problems.ts`).
2. **What to do**, one sentence, when there is something besides the buttons.
3. **The way on**, as buttons that land where the fix is done, likeliest first. A way on that is the
   whole fix happens by itself: a send whose model cannot run opens the picker.
4. **The original words**, verbatim, because they are what a report needs; folded out of the way when
   the title already explains them.

Size follows scope, at four placements of one shape: a **card** in the transcript where a run or send
went wrong (only the latest carries buttons; earlier ones are history); a **strip** floating under the
header for this view or an action outside any conversation, so nothing below moves; a **page** when there
is nothing else to show; and a **notice** at the top of the model picker (`composer.tsx`), which stacks its
title over its advice because the picker is 300 px wide. The first three are `problem.tsx`; setup pages
share the page's shape, so a first step and a problem look like the same app.

## 10. Motion

One easing and a few named shapes, used consistently: a small set of movements used everywhere reads
as polish, a large set used occasionally reads as a demo. Things arriving in the transcript rise in;
history opens still. Work in progress sweeps its word rather than blinking it. Disclosures grow to
their height instead of jumping. Streaming text is not animated: token arrival is the animation. Under
`prefers-reduced-motion` everything is instant.

## 11. Accessibility

Focus is visible on `:focus-visible` only, and never on text fields, whose caret already says it. Body
contrast stays at or above 4.5:1 in both modes, and no state is colour alone (§9). Each list is one tab
stop with arrow keys inside it (WAI-ARIA APG); a row is read with its counts and status. The
transcript is a named, focusable region, so it can be read and scrolled without a pointer.

## 11b. Keys

The whole list, so it lives in one place instead of being read out of the handlers.

| Key | Where | Does |
|---|---|---|
| `⌘N` | anywhere | New conversation in the open agent; focus its composer when ready |
| `Esc` | anywhere | Stop the running turn (a popover or the conversation list, then Settings, takes it first) |
| `⌘,` | anywhere | Open Settings (the App menu's Settings…); again keeps it open |
| `↑` `↓` `←` `→` | Settings, a choice group | Move the choice; the group is one tab stop, on the checked row |
| `Tab` | anywhere | Sidebar → transcript → composer |
| `↓` `↑` | roster | Move between agents |
| `Home` `End` | roster | First and last agent |
| `Enter` `Space` | roster | Open the agent |
| `Shift+F10`, `Menu` | roster | Its menu: `Rename…` |
| `Enter` `Space` | header's list button | Show or hide the conversation list |
| `↓` `↑` | conversation list | Move between conversations |
| `Esc` | conversation list | Close it |
| `Enter` | renaming an agent | Keep the name |
| `Esc` | renaming an agent | Drop it |
| `Enter` | composer | Send |
| `⇧Enter` | composer | Newline |
| `/` | composer | Command completion |
| `↓` `↑` | composer, list open | Move through the completions |
| `Enter` `Tab` | composer, list open | Accept the name rather than send; a skill is inserted as `/skill:<name>`, the spelling FastAgent expands |
| `Esc` | composer, list open | Dismiss the completions |
| `Esc` | model picker | Close it and return focus to the chip that opened it |
| arrows, `PageUp` `PageDown` | transcript, focused | Scroll, from Chromium |

An IME composing text keeps `Enter`: sending there would cut a word in half. Deliberately absent: `F2`
for rename (the Windows convention; macOS renames from the context menu or a double click, and only an agent can be renamed) and global
search, until there is a search surface to focus.

## 12. Brand

`kage`, lowercase everywhere, followed by a single accent dot: `kage·`. The name is playful enough
on its own.

Agent avatars are circles, because an agent is a contact; rounded squares read as a list of programs.
Settings offers several styles, all drawn in the page with nothing fetched, and every one wears the
agent's own colour (§4) on its largest part, so agents stay told apart whichever style is chosen.

## 12b. Settings

Behaviour is in [interaction.md](interaction.md); this is how it should read. Drawn the way Telegram
draws its settings: a quiet heading over an inset card, rows divided by hairlines, the choice marked by
a trailing check, fields as rows rather than one URL to spell. A chosen route says its own state as its
second line instead of offering a *Test connection* button. Settings is a place in the content area,
so running work stays visible in the sidebar.

Providers are named as people know them and led by their logos, because names alone blur together.
Subscriptions and API keys are different things and are offered as two equal choices (after Zed and
Codex). A sign-in happens inside the provider's row, which says what is happening; a dialog would cover
the list it was adding to. An unreadable credential file replaces the rows with its error, never with
an empty list (§9).
