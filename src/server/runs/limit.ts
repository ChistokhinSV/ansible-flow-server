// AFS-130: the launch's limit goes to ansible-playbook as --limit. The designer's run pipeline
// has no limit of its own, so the worker adds it to the command the container runs: the last
// argument is the shell script `... ansible-playbook ... <playbook>`, which ends with the
// ansible-playbook words, so the limit is added after them.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONTAINER, shQuote } from '@ansible-flow/core/run/command';
import { limitFile } from './hostSets';

/** AFS-240: a run again of some hosts: the file in its folder that limits it to them. */
export const LIMIT_FILE = 'limit.txt';

/**
 * AFS-240: the limit a run's ansible-playbook gets. A run again of some hosts is limited by a file
 * written now in its folder (`dir`, which the container sees at /afd-run): `--limit @file`, one
 * host per line, never split on commas, special names as anchored patterns. It takes the place of
 * the old run's limit; `@file` cannot be combined with another pattern.
 */
export async function runLimit(
  limit: string | undefined,
  hosts: readonly string[] | undefined,
  dir: string,
): Promise<string | undefined> {
  if (!hosts?.length) return limit;
  await writeFile(join(dir, LIMIT_FILE), limitFile(hosts));
  return `@${CONTAINER.run}/${LIMIT_FILE}`;
}

/** The arguments of a container run with `--limit <limit>` added to its ansible-playbook. */
export function withLimit(args: readonly string[], limit: string | undefined): string[] {
  const out = [...args];
  const pattern = limit?.trim();
  if (!pattern) return out;
  const at = out.length - 1;
  const script = out[at];
  if (out[at - 2] !== 'sh' || out[at - 1] !== '-c' || !script?.includes('ansible-playbook'))
    throw new Error('The run command has no ansible-playbook to limit');
  out[at] = `${script} --limit ${shQuote(pattern)}`;
  return out;
}
