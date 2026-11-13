// The patterns of the designer's contract with this server (@ansible-flow/assets, contract/README.md):
// whether a response body matches one, and where it does not.

export type Captures = Record<string, unknown>;

const TYPES: Record<string, (v: unknown) => boolean> = {
  $string: (v) => typeof v === 'string',
  $number: (v) => typeof v === 'number',
  $boolean: (v) => typeof v === 'boolean',
  $uuid: (v) =>
    typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v),
  $commit: (v) => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v),
  $time: (v) =>
    typeof v === 'string' && !Number.isNaN(Date.parse(v)) && /^\d{4}-\d\d-\d\dT/.test(v),
  $any: () => true,
};

/** `${name}` in a text replaced by what was captured. */
export function fill(text: string, captured: Captures): string {
  return text.replace(/\$\{(\w+)\}/g, (_, name: string) => {
    if (!(name in captured)) throw new Error(`Nothing captured as ${name}`);
    return String(captured[name]);
  });
}

/** Where the body does not match the pattern: one line per place; empty when it matches. */
export function mismatches(
  pattern: unknown,
  actual: unknown,
  captured: Captures,
  at = 'body',
): string[] {
  if (typeof pattern === 'string') {
    const check = TYPES[pattern];
    if (check)
      return check(actual) ? [] : [`${at}: not ${pattern.slice(1)}: ${JSON.stringify(actual)}`];
    const whole = /^\$\{(\w+)\}$/.exec(pattern);
    if (whole) {
      const want = captured[whole[1] as string];
      return actual === want
        ? []
        : [`${at}: ${JSON.stringify(actual)}, not the captured ${JSON.stringify(want)}`];
    }
    return actual === pattern
      ? []
      : [`${at}: ${JSON.stringify(actual)}, not ${JSON.stringify(pattern)}`];
  }
  if (Array.isArray(pattern)) {
    if (!Array.isArray(actual)) return [`${at}: not a list`];
    if (actual.length !== pattern.length)
      return [`${at}: ${actual.length} elements, not ${pattern.length}`];
    return pattern.flatMap((p, i) => mismatches(p, actual[i], captured, `${at}[${i}]`));
  }
  if (pattern && typeof pattern === 'object') {
    const p = pattern as Record<string, unknown>;
    if ('$items' in p) {
      if (!Array.isArray(actual)) return [`${at}: not a list`];
      return actual.flatMap((a, i) => mismatches(p.$items, a, captured, `${at}[${i}]`));
    }
    if ('$contains' in p)
      return typeof actual === 'string' && actual.includes(String(p.$contains))
        ? []
        : [`${at}: ${JSON.stringify(actual)} does not contain ${JSON.stringify(p.$contains)}`];
    if (!actual || typeof actual !== 'object' || Array.isArray(actual))
      return [`${at}: not an object`];
    const a = actual as Record<string, unknown>;
    return Object.entries(p).flatMap(([k, v]) =>
      k in a || v === '$any'
        ? mismatches(v, a[k], captured, `${at}.${k}`)
        : [`${at}.${k}: missing`],
    );
  }
  return actual === pattern
    ? []
    : [`${at}: ${JSON.stringify(actual)}, not ${JSON.stringify(pattern)}`];
}

/** A value of the body by a dotted path (`0.id`). */
export function pick(body: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((v, part) => (v as Record<string, unknown> | undefined)?.[part], body);
}
