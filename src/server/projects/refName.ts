// AFS-192: the rule for a branch name, with no server code, so the pages check it before asking.

/** A branch name as git allows one, and nothing that could read as an option or a range. */
export function refProblem(ref: string): string | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref))
    return 'A branch name is letters, digits, dots, dashes, underscores and slashes, and starts with a letter or digit';
  // AFS-194: a name made of allowed characters says what else is wrong with it.
  if (ref.includes('..')) return 'A branch name may not have two dots in a row (..)';
  if (ref.includes('//')) return 'A branch name may not have two slashes in a row (//)';
  if (ref.endsWith('/')) return 'A branch name may not end with a slash';
  if (ref.endsWith('.lock')) return 'A branch name may not end with .lock';
  return undefined;
}
