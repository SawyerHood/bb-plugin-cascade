# bb-plugin-cascade

A scrollable-tiling thread layout, [niri](https://github.com/YaLTeR/niri)-style:
every live thread is a column in a horizontally scrolling strip, and rows group
those columns by section, project, machine, task project, or task. `hjkl` moves,
`HL` reorders, `jk` flips rows.

It is the "big" host-component example. Cascade never touches timeline data,
drafts, streaming, sending, or thread creation UI. It owns the strip and
delegates everything inside a column to the host.

## What it demonstrates

**`experimental_NewThreadComposer` — and the composer/plugin split.** The draft
column at the end of each row renders bb's whole compose surface (prompt editor
with @-mentions, attachments, model/reasoning picker, voice, project,
environment, "Branch from:", permission mode). The composer resolves the user's
selections; **the plugin creates the thread**:

```tsx
// app.tsx — the composer resolves.
<NewThreadComposer
  defaultProjectId={draftProjectIdFor(row)}
  draftKey={`cascade:${row.key}`}
  onSubmit={startThread}
/>
```

```ts
// server.ts — the plugin files and owns attribution.
async createThread({ request, sectionId, parentThreadId, pinned }) {
  const thread = await bb.sdk.threads.spawn({
    ...request,
    ...(sectionId ? { sectionId } : {}),
    ...(parentThreadId ? { parentThreadId } : {}),
  });
  if (pinned) await bb.sdk.threads.pin({ threadId: thread.id });
  return { threadId: thread.id };
}
```

That split is the point. `bb.sdk.threads.spawn` fills in `origin: "plugin"` and
`originPluginId`, so threads Cascade creates stay attributed to Cascade. The row
the user is on decides `sectionId` / `parentThreadId` / `pinned` — filing the
composer has no opinion about. Note `startThread` **rethrows** on failure: the
composer keeps the user's draft when `onSubmit` rejects, and clears it when it
resolves.

Import it aliased — JSX reads a lowercase-initial name as an intrinsic element:

```tsx
import { experimental_NewThreadComposer as NewThreadComposer } from "@get-bb/plugin-sdk/app";
```

**`ThreadChat` at scale.** Every column is a `<ThreadChat variant="compact" />`.
A dozen live chats, each loading and streaming its own timeline, with no thread
content proxied through the plugin's own RPC. Overview (`o`) leaves every one of
them mounted: the strip only shrinks and dims, and a card layer draws over it at
normal size — one landscape card per thread, naming its project, title, and
branch. A title has no room inside a column zoomed to 80px, and unmounting the
chats to make room would reload every timeline on the way back in, so the labels
leave the scaled world instead of fighting it.

**Living beside the host's focus.** Columns mount asynchronously and each chat
autofocuses its composer, so timed focus claims lose the race. The panel bounces
any focus the user did not ask for straight back (`composerIntentRef` +
a `focusin` listener), which is what makes a bare-letter keymap safe next to a
dozen live composers.

**A thin backend.** `server.ts` owns an index built from five parallel reads
(`bb.sdk.threadSections.list`, `projects.list`, `hosts.list`, `threads.list`, and
the Tasks snapshot below), layout state in `bb.storage.kv`, and a
`bb.background.service` that publishes a `bb.realtime` signal when the index
changes. Rows are a pure projection of that flat index (`lib/rows.ts`) — never
stored.

**`bb.sdk.plugins.callRpc` — reading another plugin.** The `task projects` and
`tasks` groupings come from the builtin Tasks plugin, read over cross-plugin rpc
in `lib/tasks.ts`. Cascade never opens the Tasks plugin's SQLite file:

```ts
const { taskThreads } = await bb.sdk.plugins.callRpc({
  pluginId: "tasks",
  method: "listTaskThreads",
  input: { taskId },
  outputSchema: listTaskThreadsOutput, // loose, so Tasks may add fields
});
```

Three things that shape reads across a plugin boundary:

- **The mapping costs a call per task.** There is no bulk thread→task method, so
  the fan-out is capped, concurrency-limited, and logs what it skipped rather
  than truncating silently. Active tasks resolve first, so the cap bites on
  finished work.
- **A snapshot is cached for a few seconds.** The index refetches on every
  debounced `thread:changed`, which a running thread emits continuously, while
  task attachment barely moves. Without the cache the fan-out would run on each
  of those refetches.
- **The other plugin may be gone.** Absent, disabled, or failing rpc yields
  `tasksAvailable: false` — the task modes then leave the `g` cycle rather than
  offering a mode that can only show "No task", and a mode stored from before it
  went away falls back to sections.

Task rows are read-only drop targets. That is not a layout preference: the Tasks
rpc contract exposes no attach method, so a drop would have nothing to call. The
rows still earn their keep on the create side — a task project names the bb
project its threads belong to, so the draft column's composer opens on it.

## Install

```sh
bb plugin install git:https://github.com/SawyerHood/bb-plugin-cascade.git@^0.1.0
```

Then open **Cascade** in the sidebar. After editing sources:

```sh
bb plugin reload cascade
```

## Keymap

Trackpad and wheel move the strip too. Sideways travel always moves columns.
Vertical travel moves rows, except over a thread that still has timeline to
scroll — that thread keeps the gesture, the way nested scroll areas do
natively. A column header, the gaps, and the space around the strip are never
scrollable, so they always move rows.

`h` `l` columns · `j` `k` rows · `H` `L` reorder · `J` `K` move to row ·
`i` / `↵` composer · `esc` back · `r` width · `o` overview · `n` new thread ·
`N` child thread · `m` move to… · `g` group by · `c` rename · `S` section ·
`X` drop section · `q` archive
