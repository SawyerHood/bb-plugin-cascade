// Rename rules. Run with `npm test`.
//
// The rows here come from `buildRows`, not from hand-written literals, so the
// "only sections are renameable" guard is tested against the rows the rail
// actually draws in each grouping mode.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isRenameable,
  planRename,
  renameBlockedMessage,
} from "./rename.ts";
import { buildRows, type CascadeColumn, type CascadeIndex } from "./rows.ts";

function thread(overrides: Partial<CascadeColumn> = {}): CascadeColumn {
  return {
    threadId: "t1",
    title: "A thread",
    projectId: "p1",
    sectionId: "s1",
    hostId: "h1",
    parentThreadId: null,
    status: "idle",
    displayStatus: "idle",
    branchName: null,
    pinned: false,
    pinSortKey: null,
    unread: false,
    needsAttention: false,
    activeWorkCount: 0,
    taskId: "k1",
    taskKey: "CAS-3",
    taskProjectId: "tp1",
    createdAt: 1,
    ...overrides,
  };
}

const index: CascadeIndex = {
  sections: [{ id: "s1", name: "Cascade" }],
  projects: [{ id: "p1", name: "claude-env" }],
  hosts: [{ id: "h1", name: "this mac" }],
  taskProjects: [{ id: "tp1", name: "Cascade", bbProjectId: "p1" }],
  tasks: [{ id: "k1", name: "CAS-3 · Rename inline", taskProjectId: "tp1", bbProjectId: "p1" }],
  tasksAvailable: true,
  threads: [
    thread(),
    thread({ threadId: "t2", pinned: true }),
    // Loose on every grouping key, so each mode also gets its catch-all row.
    thread({
      threadId: "t3",
      sectionId: null,
      hostId: null,
      taskId: null,
      taskKey: null,
      taskProjectId: null,
      createdAt: 2,
    }),
  ],
};

const sectionRow = buildRows(index, "sections").find(
  (row) => row.key === "s1",
)!;

test("a new name renames the section it was typed on", () => {
  assert.deepEqual(planRename(sectionRow, "Cascade rail"), {
    kind: "rename",
    id: "s1",
    name: "Cascade rail",
  });
});

test("a name is trimmed before it is sent", () => {
  assert.deepEqual(planRename(sectionRow, "  Cascade rail  "), {
    kind: "rename",
    id: "s1",
    name: "Cascade rail",
  });
});

test("a blank name is a no-op", () => {
  for (const raw of ["", " ", "\t", "\n  "]) {
    assert.deepEqual(
      planRename(sectionRow, raw),
      { kind: "skip", reason: "blank" },
      `expected ${JSON.stringify(raw)} to be blank`,
    );
  }
});

test("the current name is a no-op, with or without padding", () => {
  for (const raw of ["Cascade", "  Cascade  "]) {
    assert.deepEqual(
      planRename(sectionRow, raw),
      { kind: "skip", reason: "unchanged" },
      `expected ${JSON.stringify(raw)} to be unchanged`,
    );
  }
});

test("only sections rows are renameable", () => {
  assert.equal(isRenameable(sectionRow), true);

  for (const mode of ["projects", "hosts", "taskProjects", "tasks"] as const) {
    const rows = buildRows(index, mode);
    assert.ok(rows.length, `${mode} produced no rows to test`);
    for (const row of rows) {
      assert.equal(
        isRenameable(row),
        false,
        `${mode} row “${row.name}” should not be renameable`,
      );
      assert.deepEqual(planRename(row, "Something else"), {
        kind: "skip",
        reason: "not-a-section",
      });
    }
  }
});

test("the derived rows of a sections grouping are not renameable either", () => {
  const derived = buildRows(index, "sections").filter(
    (row) => row.kind !== "sections",
  );
  // Pinned and Unsectioned. Neither has a section record behind it.
  assert.deepEqual(
    derived.map((row) => row.name),
    ["Pinned", "Unsectioned"],
  );
  for (const row of derived) {
    assert.equal(isRenameable(row), false);
    assert.deepEqual(planRename(row, "Something else"), {
      kind: "skip",
      reason: "not-a-section",
    });
  }
});

// The bug that made the feature look dead: pressing c on Pinned reported
// "sections aren't renameable" while grouped by sections, so the panel denied
// the one thing the key exists to do.
test("a derived row in sections grouping never blames sections", () => {
  const derived = buildRows(index, "sections").filter(
    (row) => row.kind !== "sections",
  );
  assert.ok(derived.length, "expected Pinned and Unsectioned");
  for (const row of derived) {
    const message = renameBlockedMessage(row, "sections", "sections");
    assert.ok(
      !/sections aren't renameable/.test(message),
      `“${row.name}” still reports: ${message}`,
    );
    assert.ok(
      message.includes(row.name),
      `expected the message to name the row, got: ${message}`,
    );
  }
});

test("the other groupings still name the mode", () => {
  for (const [mode, label] of [
    ["projects", "projects"],
    ["hosts", "machines"],
    ["taskProjects", "task projects"],
    ["tasks", "tasks"],
  ] as const) {
    const row = buildRows(index, mode)[0]!;
    assert.equal(
      renameBlockedMessage(row, mode, label),
      `${label} aren't renameable`,
    );
  }
});

test("no row at all is a no-op", () => {
  assert.equal(isRenameable(null), false);
  assert.equal(isRenameable(undefined), false);
  assert.deepEqual(planRename(undefined, "Anything"), {
    kind: "skip",
    reason: "not-a-section",
  });
});
