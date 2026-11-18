// AFS-140: what is wrong with a collection of a spec, in words. Values only, no server code: the
// pages check a row before saving, and say it at the name or the version it is about.

/** Why a collection row cannot be built, and whether its name or its version is wrong. */
export function collectionProblem(
  c: { name: string; version: string },
  seen: ReadonlySet<string> = new Set(),
): { part: 'name' | 'version'; message: string } | undefined {
  if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(c.name))
    return {
      part: 'name',
      message: `"${c.name.slice(0, 60)}" is not a collection name (namespace.name)`,
    };
  if (seen.has(c.name)) return { part: 'name', message: `${c.name} is there twice` };
  const v = c.version.trim();
  if (
    v &&
    v !== 'latest' &&
    !/^(\*|[<>=!]=?\s*\d[\w.+-]*)(\s*,\s*[<>=!]=?\s*\d[\w.+-]*)*$|^\d[\w.+-]*$/.test(v)
  )
    return {
      part: 'version',
      message: `${c.name}: "${v.slice(0, 40)}" is not a version, a range (>=11.0.0,<12) or latest`,
    };
  return undefined;
}
