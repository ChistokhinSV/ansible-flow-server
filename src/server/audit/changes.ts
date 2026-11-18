// AFS-141: the fields a change really changed. A form sends every field it has, so the fields a
// request named say little; this compares the thing before and after, for the audit log.

/** null, undefined and '' are one "not set"; the rest compares as JSON. */
const same = (a: unknown, b: unknown) => {
  const unset = (v: unknown) => v === undefined || v === null || v === '';
  if (unset(a) || unset(b)) return unset(a) && unset(b);
  return JSON.stringify(a) === JSON.stringify(b);
};

/** The fields of `body` whose value differs between `before` and `after`. */
export function changedKeys(
  body: object,
  before: object | undefined,
  after: object | undefined,
): string[] {
  const was = (before ?? {}) as Record<string, unknown>;
  const now = (after ?? {}) as Record<string, unknown>;
  return Object.keys(body).filter((key) => !same(was[key], now[key]));
}
