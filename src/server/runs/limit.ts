// AFS-130: the launch's limit goes to ansible-playbook as --limit. The designer's run pipeline
// has no limit of its own, so the worker adds it to the command the container runs: the last
// argument is the shell script `... ansible-playbook ... <playbook>`, which ends with the
// ansible-playbook words, so the limit is added after them.
import { shQuote } from '@ansible-flow/core/run/command';

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
