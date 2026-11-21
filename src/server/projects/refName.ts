// AFS-192: the rule for a branch name, with no server code, so the pages check it before asking.

/** A branch name as git allows one, and nothing that could read as an option or a range. */
export function refProblem(ref: string): string | undefined {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref) && !/\.\.|\/\/|\.lock$|\/$/.test(ref)
    ? undefined
    : 'A branch name is letters, digits, dots, dashes, underscores and slashes';
}
