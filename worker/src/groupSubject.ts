// The "subject id" trick that lets group mode (PLAN.md 17) reuse every
// state.ts/signedState.ts function unchanged: none of them actually
// validate that the id they're given is a real LINE userId, they just use
// it as an opaque KV key / signed-payload string. Personal mode's subject
// id is the real LINE userId; group mode synthesizes "group:<groupId>"
// instead. A LINE userId can never contain a colon, so a group and a
// personal account can never accidentally share state.
//
// Split out from index.ts into its own module so viewCommands.ts (and any
// other file downstream of index.ts's own imports) can use it too without
// creating an import cycle — index.ts already imports from viewCommands.ts.
const GROUP_SUBJECT_PREFIX = "group:";

export function groupSubjectId(groupId: string): string {
  return `${GROUP_SUBJECT_PREFIX}${groupId}`;
}

export function groupIdFromSubject(subjectId: string): string | null {
  return subjectId.startsWith(GROUP_SUBJECT_PREFIX) ? subjectId.slice(GROUP_SUBJECT_PREFIX.length) : null;
}
