// AFS-181: a host that reaches a flow's failed end (a rejection, a timeout, any failed outcome)
// fails the end's own generated task. Since ansible-core 2.19 Ansible prints every failed task's
// origin under its [ERROR] line: "Origin: <generated playbook>:<line>:<col>", then a few lines of
// the generated playbook with a "^ column N" marker. No setting turns it off. For an end of the
// flow it only shows generated code, so the run page leaves it out; the output file keeps it.
// AFS-193: the same for a host stopped at a port with no next step ("failed_hosts is not wired",
// "... open on purpose"): the generated stop, not a step's own task.

// biome-ignore lint/suspicious/noControlCharactersInRegex: the colours Ansible writes
const ANSI = /\u001b\[[0-9;]*m/g;
const plain = (line: string) => line.replace(ANSI, '');

/**
 * The [ERROR] line of a flow's end (the message the generator writes ends "(outcome: failed)"),
 * or of a host stopped at a port with no next step.
 */
const END_ERROR =
  /^\[ERROR\]: Task failed: .*(\(outcome: failed\)|: \w+ is not wired|: \w+ open on purpose \(.*\))\s*$/;
const STOPS = ['(outcome: failed)', ' is not wired', ' open on purpose'];
const ORIGIN = /^Origin: \S/;
const CARET = /^\s*\^ column \d+\s*$/;
/** An excerpt is a few lines; past this, it is not one, and nothing is left out. */
const MOST = 12;

/** The output with the code excerpt under each failed end's error left out. */
export function quietEndOrigins(text: string): string {
  if (!STOPS.some((stop) => text.includes(stop))) return text;
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    out.push(line);
    if (!END_ERROR.test(plain(line)) || !ORIGIN.test(plain(lines[i + 1] ?? ''))) continue;
    let caret = -1;
    for (let j = i + 2; j < Math.min(lines.length, i + 2 + MOST); j++)
      if (CARET.test(plain(lines[j] as string))) {
        caret = j;
        break;
      }
    // Not all here yet (the output is still coming) or not an excerpt: shown as it is.
    if (caret < 0) continue;
    // The blank line that closes the excerpt goes with it.
    i = plain(lines[caret + 1] ?? 'x').trim() === '' ? caret + 1 : caret;
  }
  return out.join('\n');
}

/**
 * AFS-193: a host that a rejection (or no decision in time) sent to a failed end is not a failed
 * host: the end's message says "(outcome: rejected)" or "(outcome: not decided in time)" on the
 * run page. The generator writes "Rejected at ... Ended at ... (outcome: failed)".
 */
export function decidedOutcomes(text: string): string {
  if (!text.includes('(outcome: failed)')) return text;
  return text
    .split(String.fromCharCode(10))
    .map((line) =>
      line.includes('Rejected at ')
        ? line.replaceAll('(outcome: failed)', '(outcome: rejected)')
        : line.includes('No decision in time at ')
          ? line.replaceAll('(outcome: failed)', '(outcome: not decided in time)')
          : line,
    )
    .join(String.fromCharCode(10));
}
