// The Tasks bridge.
//
// Cascade reads the Tasks plugin through `bb.sdk.plugins.callRpc` — the
// sanctioned cross-plugin path — and never touches the Tasks plugin's own
// SQLite file. Everything here is read-only: the Tasks rpc contract exposes no
// way to attach a thread to a task, which is why the task rows render as
// read-only drop targets (see `buildRows`).
import { z } from "zod";
import type { TaskEntry, TaskProjectEntry } from "./rows";

const TASKS_PLUGIN_ID = "tasks";

/** Page size for `listTasks`; the contract caps a page at 500. */
const TASK_PAGE_LIMIT = 200;

/**
 * How many tasks we resolve attached threads for.
 *
 * There is no bulk thread→task rpc, only `listTaskThreads({ taskId })`, so the
 * mapping costs one call per task. That is fine for a working board and wrong
 * for an archive, so the fan-out is capped and the skipped count is logged
 * rather than silently swallowed. Active tasks are resolved first, so the cap
 * bites on finished work.
 */
const TASK_FANOUT_LIMIT = 200;

/** Concurrent `listTaskThreads` calls. Loopback, but still one call each. */
const TASK_FANOUT_CONCURRENCY = 8;

/**
 * How long a snapshot is reused.
 *
 * The index refetches on every debounced `thread:changed`, and a running thread
 * emits those continuously, while task attachment changes only when someone
 * dispatches or attaches. Re-running the fan-out on each of those refetches
 * would multiply the index cost for data that almost never moved, so a snapshot
 * is reused for this long. The cost is that an attach made in the Tasks UI can
 * take this long to reach the strip.
 */
const SNAPSHOT_TTL_MS = 4000;

/** Rank used both for the fan-out cap and for row order within a project. */
const STATUS_RANK: Record<string, number> = {
  in_progress: 0,
  in_review: 1,
  todo: 2,
  backlog: 3,
  done: 4,
  canceled: 5,
};

// Deliberately loose object schemas: `callRpc` validates the whole response
// against these, and zod strips unknown keys, so the Tasks plugin can add
// fields without breaking Cascade. Only what a row needs is named.
const taskProjectRpcSchema = z.object({
  id: z.string(),
  name: z.string(),
  linkedBbProjectId: z.string().nullable(),
});

const listProjectsOutput = z.object({
  projects: z.array(taskProjectRpcSchema),
});

const taskRpcSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  number: z.number(),
  key: z.string(),
  title: z.string(),
  status: z.string(),
});

const listTasksOutput = z.object({
  tasks: z.array(taskRpcSchema),
  nextCursor: z.string().nullable(),
});

const listTaskThreadsOutput = z.object({
  taskThreads: z.array(
    z.object({
      taskId: z.string(),
      threadId: z.string(),
      attachedAt: z.string(),
    }),
  ),
});

/** Where one thread's column sits in the task modes. */
export interface ThreadTask {
  taskId: string;
  taskKey: string;
  taskProjectId: string;
}

export interface TasksSnapshot {
  /** False when the Tasks plugin is absent, disabled, or unreachable. */
  available: boolean;
  projects: TaskProjectEntry[];
  tasks: TaskEntry[];
  byThread: Map<string, ThreadTask>;
}

const EMPTY_SNAPSHOT: TasksSnapshot = {
  available: false,
  projects: [],
  tasks: [],
  byThread: new Map(),
};

/** The slice of the plugin api this module needs, so it stays testable. */
export interface TasksBridgeApi {
  sdk: {
    plugins: {
      callRpc<TOutput>(args: {
        pluginId: string;
        method: string;
        input?: unknown;
        outputSchema: z.ZodType<TOutput>;
      }): Promise<TOutput>;
    };
  };
  log: { warn(message: string): void };
}

/** Run `worker` over `items` with at most `limit` in flight. */
async function mapWithConcurrency<TItem, TResult>(
  items: readonly TItem[],
  limit: number,
  worker: (item: TItem) => Promise<TResult>,
): Promise<TResult[]> {
  const results: TResult[] = new Array(items.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        const item = items[index];
        if (item === undefined) return;
        results[index] = await worker(item);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

type RawTask = z.infer<typeof taskRpcSchema>;

async function readAllTasks(bb: TasksBridgeApi): Promise<RawTask[]> {
  const tasks: RawTask[] = [];
  let cursor: string | undefined;
  // The contract binds a cursor to the task-list revision, so a mutation
  // mid-page makes it stale. Restart once rather than serve a truncated list —
  // a missing task would drop its threads into "No task", which reads as a bug.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    tasks.length = 0;
    cursor = undefined;
    try {
      for (;;) {
        // Annotated: inferring it from `callRpc` inside its own loop is
        // circular, because the next input reads the previous page's cursor.
        const page: z.infer<typeof listTasksOutput> =
          await bb.sdk.plugins.callRpc({
            pluginId: TASKS_PLUGIN_ID,
            method: "listTasks",
            input: {
              limit: TASK_PAGE_LIMIT,
              sort: "manual",
              ...(cursor ? { cursor } : {}),
            },
            outputSchema: listTasksOutput,
          });
        tasks.push(...page.tasks);
        if (!page.nextCursor) return tasks;
        cursor = page.nextCursor;
      }
    } catch (error) {
      if (attempt === 1) throw error;
      bb.log.warn(
        `task list page failed, restarting: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return tasks;
}

async function readSnapshot(bb: TasksBridgeApi): Promise<TasksSnapshot> {
  const [{ projects: rawProjects }, rawTasks] = await Promise.all([
    bb.sdk.plugins.callRpc({
      pluginId: TASKS_PLUGIN_ID,
      method: "listProjects",
      input: {},
      outputSchema: listProjectsOutput,
    }),
    readAllTasks(bb),
  ]);

  const projects: TaskProjectEntry[] = rawProjects.map((project) => ({
    id: project.id,
    name: project.name,
    bbProjectId: project.linkedBbProjectId,
  }));

  const projectOrder = new Map(
    projects.map((project, index) => [project.id, index]),
  );
  const bbProjectOf = new Map(
    projects.map((project) => [project.id, project.bbProjectId]),
  );

  // Row order: project order, then task number.
  //
  // Both are immutable, which is the point. Rows are a spatial layout for the
  // same reason columns are — you learn that MUR-3 is the fourth row and reach
  // for it — so ordering by anything that moves would reshuffle the panel while
  // the user works in it. Status is the obvious temptation and exactly the wrong
  // key: a task going to done would slide every row below it.
  const sorted = [...rawTasks].sort((a, b) => {
    const byProject =
      (projectOrder.get(a.projectId) ?? Number.MAX_SAFE_INTEGER) -
      (projectOrder.get(b.projectId) ?? Number.MAX_SAFE_INTEGER);
    if (byProject !== 0) return byProject;
    return a.number - b.number;
  });

  const tasks: TaskEntry[] = sorted.map((task) => ({
    id: task.id,
    // The key leads: the row rail is narrow and truncates, and "CAS-1" is what
    // the user typed to get here.
    name: `${task.key} · ${task.title}`,
    taskProjectId: task.projectId,
    bbProjectId: bbProjectOf.get(task.projectId) ?? null,
  }));

  // Which tasks get their threads resolved when the fan-out is capped. Status
  // ranks here and nowhere else: row order must stay put (above), but spending a
  // limited call budget on live work rather than finished work is exactly right.
  const fanout = [...sorted]
    .sort(
      (a, b) =>
        (STATUS_RANK[a.status] ?? STATUS_RANK.canceled!) -
        (STATUS_RANK[b.status] ?? STATUS_RANK.canceled!),
    )
    .slice(0, TASK_FANOUT_LIMIT);
  if (sorted.length > fanout.length) {
    bb.log.warn(
      `resolved attached threads for ${fanout.length} of ${sorted.length} tasks; ` +
        `threads on the remaining tasks show under "No task"`,
    );
  }

  const keyOf = new Map(sorted.map((task) => [task.id, task.key]));
  const projectOf = new Map(sorted.map((task) => [task.id, task.projectId]));

  const attachments = await mapWithConcurrency(
    fanout,
    TASK_FANOUT_CONCURRENCY,
    async (task) => {
      try {
        const { taskThreads } = await bb.sdk.plugins.callRpc({
          pluginId: TASKS_PLUGIN_ID,
          method: "listTaskThreads",
          input: { taskId: task.id },
          outputSchema: listTaskThreadsOutput,
        });
        return taskThreads;
      } catch {
        // One unreadable task must not blank the whole strip.
        return [];
      }
    },
  );

  // A thread attached to several tasks resolves to its earliest attachment, so
  // the column lands in exactly one row and stays there.
  const earliest = new Map<string, { at: string; taskId: string }>();
  for (const taskThreads of attachments) {
    for (const link of taskThreads) {
      const current = earliest.get(link.threadId);
      if (
        !current ||
        link.attachedAt < current.at ||
        (link.attachedAt === current.at && link.taskId < current.taskId)
      ) {
        earliest.set(link.threadId, { at: link.attachedAt, taskId: link.taskId });
      }
    }
  }

  const byThread = new Map<string, ThreadTask>();
  for (const [threadId, { taskId }] of earliest) {
    const taskProjectId = projectOf.get(taskId);
    if (!taskProjectId) continue;
    byThread.set(threadId, {
      taskId,
      taskKey: keyOf.get(taskId) ?? taskId,
      taskProjectId,
    });
  }

  return { available: true, projects, tasks, byThread };
}

/**
 * A snapshot reader with a short TTL. Returns an unavailable snapshot instead of
 * throwing, so the strip still draws when the Tasks plugin is disabled.
 */
export function createTasksReader(
  bb: TasksBridgeApi,
  now: () => number = Date.now,
): () => Promise<TasksSnapshot> {
  let cached: { at: number; value: TasksSnapshot } | null = null;
  let inFlight: Promise<TasksSnapshot> | null = null;

  return async function read(): Promise<TasksSnapshot> {
    if (cached && now() - cached.at < SNAPSHOT_TTL_MS) return cached.value;
    // Overlapping index refetches share one read rather than each starting a
    // fan-out of their own.
    if (inFlight) return inFlight;
    inFlight = readSnapshot(bb)
      .catch((error: unknown) => {
        bb.log.warn(
          `tasks unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
        return EMPTY_SNAPSHOT;
      })
      .then((value) => {
        cached = { at: now(), value };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}
