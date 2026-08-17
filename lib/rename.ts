// What a rename does, decided without a DOM or a bb server.
//
// The rules themselves are the ones the toolbar input already applied; they
// live here so the rail row, the toolbar entry point, and a test all read the
// same decision instead of each repeating it.

import type { CascadeRow } from "./rows";

/** The parts of a row a rename cares about. */
export type RenameTarget = Pick<CascadeRow, "key" | "name" | "kind">;

/**
 * Only a section row owns its own name.
 *
 * Every other row names something Cascade is a view of — a bb project, a
 * machine, a Tasks task — and rewriting that from a layout panel would edit the
 * wrong thing. Pinned and Unsectioned are derived rows with no record behind
 * them at all.
 */
export function isRenameable(row: RenameTarget | null | undefined): boolean {
  return row?.kind === "sections";
}

/**
 * Why the focused row refuses to be renamed, in words for the user.
 *
 * Outside a sections grouping the whole mode refuses, and naming the mode is
 * the clearest thing to say. Inside one, sections are exactly what *can* be
 * renamed, and the rows that refuse are the derived two, so naming the mode
 * there produces "sections aren't renameable" and denies the very thing the
 * key does. Name the row instead.
 */
export function renameBlockedMessage(
  row: RenameTarget | null | undefined,
  mode: string,
  modeLabel: string,
): string {
  if (mode !== "sections") return `${modeLabel} aren't renameable`;
  return row ? `“${row.name}” is not a section` : "There is no row to rename";
}

export type RenamePlan =
  | { kind: "rename"; id: string; name: string }
  | { kind: "skip"; reason: "not-a-section" | "blank" | "unchanged" };

/**
 * What committing `raw` on `row` should do.
 *
 * A blank name and an unchanged name are both no-ops: closing the editor
 * without typing, or typing the name back, is a cancel — not a request to send
 * the section a name it already has.
 */
export function planRename(
  row: RenameTarget | null | undefined,
  raw: string,
): RenamePlan {
  if (!row || !isRenameable(row)) return { kind: "skip", reason: "not-a-section" };
  const name = raw.trim();
  if (!name) return { kind: "skip", reason: "blank" };
  if (name === row.name) return { kind: "skip", reason: "unchanged" };
  return { kind: "rename", id: row.key, name };
}
