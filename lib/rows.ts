// Row derivation. Rows are never stored — they are a projection of the flat
// thread index through one grouping key. Kept pure so it is unit-testable
// without a bb server.

export type GroupingMode =
  | "sections"
  | "projects"
  | "hosts"
  | "taskProjects"
  | "tasks";

/** The order `g` cycles through. Task modes come last, and are skipped when
 *  the Tasks plugin is unavailable (see `availableModes`). */
export const GROUPING_MODES: readonly GroupingMode[] = [
  "sections",
  "projects",
  "hosts",
  "taskProjects",
  "tasks",
] as const;

/** Grouping modes that need the Tasks plugin to produce any row at all. */
const TASK_MODES: readonly GroupingMode[] = ["taskProjects", "tasks"] as const;

export function isTaskMode(mode: GroupingMode): boolean {
  return TASK_MODES.includes(mode);
}

/** The modes `g` may land on. Hiding rather than emptying the task modes keeps
 *  the cycle from stepping through rows that can never exist. */
export function availableModes(tasksAvailable: boolean): GroupingMode[] {
  return GROUPING_MODES.filter((mode) => tasksAvailable || !isTaskMode(mode));
}

export interface CascadeColumn {
  threadId: string;
  title: string;
  projectId: string;
  sectionId: string | null;
  hostId: string | null;
  parentThreadId: string | null;
  status: string;
  displayStatus: string;
  branchName: string | null;
  pinned: boolean;
  pinSortKey: string | null;
  unread: boolean;
  needsAttention: boolean;
  activeWorkCount: number;
  /**
   * The Tasks-plugin task this thread is attached to, or null.
   *
   * A thread may be attached to several tasks; the server resolves it to the
   * earliest attachment so the column keeps ONE row. Rows have to be exclusive
   * — the same live chat in two scrollable places is the problem the Pinned row
   * already avoids.
   */
  taskId: string | null;
  /** The task's human key ("CAS-1"), carried so a card needs no lookup map. */
  taskKey: string | null;
  taskProjectId: string | null;
  /** Immutable, so it can anchor a stable column position. */
  createdAt: number;
}

export interface Named {
  id: string;
  name: string;
}

/** A Tasks-plugin project. `bbProjectId` is its linked bb project, when set. */
export interface TaskProjectEntry extends Named {
  bbProjectId: string | null;
}

/** A Tasks-plugin task. `name` is already "CAS-1 · title". */
export interface TaskEntry extends Named {
  taskProjectId: string;
  bbProjectId: string | null;
}

export interface CascadeIndex {
  sections: Named[];
  projects: Named[];
  hosts: Named[];
  taskProjects: TaskProjectEntry[];
  tasks: TaskEntry[];
  /**
   * False when the Tasks plugin is absent, disabled, or unreachable. The task
   * modes then carry no rows, so the frontend drops them from the `g` cycle
   * rather than offering a mode that can only ever show "No task".
   */
  tasksAvailable: boolean;
  threads: CascadeColumn[];
}

/** What dropping a thread into a row does. */
export type RowDrop =
  | { kind: "pin" }
  | { kind: "section"; sectionId: string | null }
  | { kind: "none" };

export interface CascadeRow {
  /** Stable identity used for focus memory, manual order, and drop targets. */
  key: string;
  name: string;
  kind: GroupingMode | "pinned" | "unsectioned";
  drop: RowDrop;
  /** True when this row's order is user-controlled. */
  reorderable: boolean;
  /**
   * The bb project a new thread in this row belongs to, when the row names one.
   * A projects row IS a project; a task row inherits the bb project its Tasks
   * project is linked to. Null everywhere else, and the draft column then
   * inherits from a neighbouring column instead.
   */
  bbProjectId: string | null;
  columns: CascadeColumn[];
}

export const PINNED_KEY = "__pinned";
export const UNSECTIONED_KEY = "__unsectioned";
export const NO_TASK_KEY = "__notask";

/**
 * Row keys share one kv namespace for focus memory and manual order, and task
 * ids and section ids are both ULIDs, so the task modes prefix theirs. Without
 * it a section and a task could collide and silently share a remembered focus.
 */
const KEY_PREFIX: Partial<Record<GroupingMode, string>> = {
  taskProjects: "taskproj:",
  tasks: "task:",
};

function rowKeyFor(mode: GroupingMode, id: string): string {
  return `${KEY_PREFIX[mode] ?? ""}${id}`;
}

/** The catch-all row's key: the task modes name a different thing from sections. */
function looseKeyFor(mode: GroupingMode): string {
  return isTaskMode(mode) ? NO_TASK_KEY : UNSECTIONED_KEY;
}

const LOOSE_NAME: Record<GroupingMode, string> = {
  sections: "Unsectioned",
  projects: "Unsectioned",
  hosts: "No machine",
  taskProjects: "No task",
  tasks: "No task",
};

/**
 * Applies a manual order to a group.
 *
 * Column position must never change on its own. A strip is a spatial layout —
 * you learn where a thread sits and reach for it — so reordering under the user
 * while they work in a column is the one thing it cannot do. That rules out
 * recency: `updatedAt` bumps on every turn, which would shuffle the strip
 * exactly when you are typing in it.
 *
 * So: threads named in `order` come first, in that order, and everything else
 * falls back to `createdAt` ascending. Creation time is immutable, so an
 * un-dragged thread has a fixed slot too, and a new one always appears at the
 * right-hand end rather than jumping to the front. Stale ids in `order` are
 * ignored rather than pruned, so a thread that leaves and returns keeps its
 * slot.
 */
function applyOrder(
  columns: CascadeColumn[],
  order: readonly string[] | undefined,
): CascadeColumn[] {
  const stable = [...columns].sort((a, b) => a.createdAt - b.createdAt);
  if (!order?.length) return stable;

  const remaining = new Map(stable.map((c) => [c.threadId, c]));
  const ordered: CascadeColumn[] = [];
  for (const threadId of order) {
    const column = remaining.get(threadId);
    if (!column) continue;
    remaining.delete(threadId);
    ordered.push(column);
  }
  return [...ordered, ...remaining.values()];
}

/** The grouping keys of `mode`, in row order, with the bb project each implies. */
function entriesFor(
  index: CascadeIndex,
  mode: GroupingMode,
): { id: string; name: string; bbProjectId: string | null }[] {
  switch (mode) {
    case "sections":
      return index.sections.map((s) => ({ ...s, bbProjectId: null }));
    case "projects":
      // A projects row IS a bb project, so it can seed the composer directly.
      return index.projects.map((p) => ({ ...p, bbProjectId: p.id }));
    case "hosts":
      return index.hosts.map((h) => ({ ...h, bbProjectId: null }));
    case "taskProjects":
      return index.taskProjects.map((p) => ({
        id: p.id,
        name: p.name,
        bbProjectId: p.bbProjectId,
      }));
    case "tasks":
      return index.tasks.map((t) => ({
        id: t.id,
        name: t.name,
        bbProjectId: t.bbProjectId,
      }));
  }
}

/** Which group a thread belongs to under `mode`. */
function groupKeyOf(thread: CascadeColumn, mode: GroupingMode): string {
  switch (mode) {
    case "sections":
      return thread.sectionId ?? UNSECTIONED_KEY;
    case "projects":
      return thread.projectId;
    case "hosts":
      return thread.hostId ?? UNSECTIONED_KEY;
    case "taskProjects":
      return thread.taskProjectId ?? NO_TASK_KEY;
    case "tasks":
      return thread.taskId ?? NO_TASK_KEY;
  }
}

/**
 * Projects the flat index into rows.
 *
 * Pinned threads get their own row and appear ONLY there. bb's sidebar shows a
 * pinned thread twice (Pinned plus its section), which reads fine in a tree but
 * would put the same live column in two places you can scroll to — and make a
 * drag out of Pinned ambiguous. Here the row is exclusive, so dragging a thread
 * out of it unpins.
 *
 * Only sections and pinning are writable: a thread's project, host, and task
 * describe where it actually lives, so those rows render read-only. (The Tasks
 * plugin exposes no attach method over its rpc contract, so a task row could
 * not accept a drop even if the layout wanted it to.)
 *
 * An empty section still gets a row. It is the only writable grouping, so its
 * row is the drop target that a freshly created section needs before anything
 * lives in it — drop the row and there is nowhere to drag, `m`, or `⇧jk` a
 * thread to. Every other grouping stays dropped when empty: those rows are
 * read-only, so an empty one is a rail slot you can never fill.
 */
export function buildRows(
  index: CascadeIndex,
  mode: GroupingMode,
  order: Record<string, string[]> = {},
): CascadeRow[] {
  const rows: CascadeRow[] = [];

  const pinned = index.threads.filter((thread) => thread.pinned);
  if (pinned.length) {
    rows.push({
      key: PINNED_KEY,
      name: "Pinned",
      kind: "pinned",
      drop: { kind: "pin" },
      reorderable: true,
      bbProjectId: null,
      // Pinned order is server-side (`pinSortKey`), shared with the sidebar.
      columns: [...pinned].sort((a, b) =>
        (a.pinSortKey ?? "").localeCompare(b.pinSortKey ?? ""),
      ),
    });
  }

  const rest = index.threads.filter((thread) => !thread.pinned);

  const byKey = new Map<string, CascadeColumn[]>();
  for (const thread of rest) {
    const key = groupKeyOf(thread, mode);
    const existing = byKey.get(key);
    if (existing) existing.push(thread);
    else byKey.set(key, [thread]);
  }

  for (const entry of entriesFor(index, mode)) {
    const columns = byKey.get(entry.id) ?? [];
    if (!columns.length && mode !== "sections") continue;
    const key = rowKeyFor(mode, entry.id);
    rows.push({
      key,
      name: entry.name,
      kind: mode,
      drop:
        mode === "sections"
          ? { kind: "section", sectionId: entry.id }
          : { kind: "none" },
      reorderable: true,
      bbProjectId: entry.bbProjectId,
      columns: applyOrder(columns, order[key]),
    });
  }

  const looseKey = looseKeyFor(mode);
  const loose = byKey.get(looseKey);
  if (loose?.length) {
    rows.push({
      key: looseKey,
      name: LOOSE_NAME[mode],
      kind: "unsectioned",
      drop:
        mode === "sections"
          ? { kind: "section", sectionId: null }
          : { kind: "none" },
      reorderable: true,
      bbProjectId: null,
      columns: applyOrder(loose, order[looseKey]),
    });
  }

  return rows;
}

/** True when a thread can be dropped into this row at all. */
export function acceptsDrop(row: CascadeRow): boolean {
  return row.drop.kind !== "none";
}

/**
 * A column draws its parent connector only when the parent is the column
 * immediately to its left — that is what the connector actually claims.
 */
export function isAdjacentChild(
  columns: CascadeColumn[],
  index: number,
): boolean {
  const column = columns[index];
  if (!column?.parentThreadId || index === 0) return false;
  return columns[index - 1]?.threadId === column.parentThreadId;
}

/** Clamp a remembered focus index; `columns.length` is the draft slot. */
export function clampFocus(row: CascadeRow, remembered: number): number {
  return Math.max(0, Math.min(remembered, row.columns.length));
}

/** Move `threadId` to `to` within a row, returning the new id order. */
export function reorderIds(
  columns: CascadeColumn[],
  threadId: string,
  to: number,
): string[] {
  const ids = columns.map((column) => column.threadId);
  const from = ids.indexOf(threadId);
  if (from < 0) return ids;
  ids.splice(from, 1);
  ids.splice(from < to ? to - 1 : to, 0, threadId);
  return ids;
}
