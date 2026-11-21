// AFS-191: a launch that would run on no host is asked about first, on the launch page and in the
// canvas's Run dialog alike.
import type { FactsReply } from '../server/launch/facts';

/**
 * AFS-191: why a launch would run on no host at all, as the inventory says it now; undefined when
 * some host would run, or when that is not known (the inventory could not be read).
 */
export function noHostWhy(reply: FactsReply | undefined): string | undefined {
  if (!reply) return undefined;
  if (reply.limited?.count === 0)
    return `the limit ${reply.limited.pattern} leaves none of the targets' hosts`;
  if (reply.facts)
    return reply.facts.count === 0 ? 'the targets match no host in the inventory' : undefined;
  // The designer's words for targets that are empty or not in the inventory at all; not a
  // container that did not answer, which says nothing of the hosts.
  const why = reply.factsError;
  if (why && !reply.field && /^(None of the targets|No target hosts)/.test(why))
    return `${why[0]?.toLowerCase()}${why.slice(1)}`;
  return undefined;
}
