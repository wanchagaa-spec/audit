// Finding the duplicate photos 17.68 stopped producing (PLAN.md 17.69).
//
// 17.68 made the upload queue stop handing the same job out twice. It could
// not undo what had already happened: a real trip folder was left holding
// several copies of the same photo, and the bug it came from is as old as
// the queue itself, so older trips can be carrying copies too.
//
// Pure functions on their own so the decision — which file survives, which
// ones go — can be tested directly, without a Drive round-trip standing
// between the test and the rule being checked.

import type { DriveFileSummary } from "./drive.ts";

export interface DuplicateGroup {
  /** The shared filename. Also the group's identity in the form post. */
  name: string;
  /** The copy that stays. */
  keep: DriveFileSummary;
  /** Every other copy, oldest first. */
  remove: DriveFileSummary[];
}

/**
 * Same name means same file, with no heuristics involved.
 *
 * uploadTripMedia names every upload `<date>_<messageId>.<ext>`, and a LINE
 * messageId identifies exactly one piece of media for all time. Two files
 * sharing a name are therefore always two copies of one photo — never two
 * different photos that happen to look alike, which is what makes deleting
 * one of them safe to offer at all. Anything fuzzier (same size, same
 * minute, similar image) would be a guess, and a guess here throws away
 * somebody's only copy of a photo.
 *
 * Files whose names do not follow that pattern still group correctly: the
 * rule is only ever "identical name", so a folder holding something the bot
 * did not upload is not treated specially — it simply has no duplicates
 * unless a second file shares its exact name.
 */
export function findDuplicateGroups(files: DriveFileSummary[]): DuplicateGroup[] {
  const byName = new Map<string, DriveFileSummary[]>();
  for (const file of files) {
    const group = byName.get(file.name) ?? [];
    group.push(file);
    byName.set(file.name, group);
  }

  const groups: DuplicateGroup[] = [];
  for (const [name, copies] of byName) {
    if (copies.length < 2) continue;
    // Oldest first, so the copy that stays is the one that was there first:
    // it is the upload the user was told about, it is the one any link
    // already points at, and it is the only choice that does not depend on
    // the order Drive happened to list the folder in. `id` breaks a tie so
    // the same folder always produces the same answer — two files written
    // in the same second is exactly what a double-upload looks like.
    const sorted = [...copies].sort(
      (a, b) => a.createdTime.localeCompare(b.createdTime) || a.id.localeCompare(b.id)
    );
    groups.push({ name, keep: sorted[0], remove: sorted.slice(1) });
  }

  // Newest duplicate first: the ones worth looking at are the ones that just
  // happened, not a pair from a trip months ago.
  return groups.sort((a, b) => b.keep.createdTime.localeCompare(a.keep.createdTime) || a.name.localeCompare(b.name));
}

/** How many files would actually be removed — the number the confirm button
 * has to say, which is never the number of groups. */
export function duplicateFileCount(groups: DuplicateGroup[]): number {
  return groups.reduce((sum, g) => sum + g.remove.length, 0);
}
