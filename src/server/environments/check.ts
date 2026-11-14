// Does an execution environment hold what a flow needs (AFS-33)? What the flow needs is read from
// its steps (`flowCollections` of @ansible-flow/core, AFD-274) and the project's
// collections/requirements.yml, which wins; it is compared with what the environment's image
// really holds (the catalog its build read). Each collection is there at a version that fits, too
// old or too new, or missing. And the spec of an environment made for the flow.
import {
  flowCollections,
  mergeRequirements,
  type Requirement,
} from '@ansible-flow/core/flow/collections';
import type { FlowDocument } from '@ansible-flow/core/flow/types';
import { parseRequirements, satisfies } from '@ansible-flow/core/lens/requirements';
import type { CheckLine, CollectionWant, EnvironmentSpec, ImageCatalog } from './types';

export type { CheckLine } from './types';

/** Where a project keeps the collections it needs, as AWX and the designer read it. */
export const REQUIREMENTS_FILE = 'collections/requirements.yml';

/** What a flow needs, from its steps and the project's requirements file (its text, if any). */
export function flowNeeds(doc: FlowDocument, requirementsText?: string): Requirement[] {
  const pins = requirementsText ? parseRequirements(requirementsText) : {};
  return mergeRequirements(flowCollections(doc), pins);
}

/** Each need against an image's catalog; without a catalog, nothing is known to be there. */
export function checkNeeds(needs: Requirement[], catalog?: ImageCatalog): CheckLine[] {
  return needs.map((n) => {
    const has = catalog?.collections[n.name];
    const base = {
      name: n.name,
      wants: n.version,
      from: n.from,
      nodes: n.nodes,
      ...(n.conflict ? { conflict: n.conflict } : {}),
    };
    if (!catalog)
      return { ...base, ok: false, why: 'The environment has not been read yet: build it' };
    if (!has) return { ...base, ok: false, why: 'Not in the image' };
    if (!satisfies(has, n.version))
      return { ...base, has, ok: false, why: `The image has ${has}; ${n.version} is needed` };
    return { ...base, has, ok: true };
  });
}

/** The collections an environment made for these needs asks for: a range kept, `*` as latest. */
export function specFor(needs: Requirement[], base?: Partial<EnvironmentSpec>): EnvironmentSpec {
  const collections: CollectionWant[] = needs.map((n) => ({
    name: n.name,
    version: n.version === '*' || !n.version ? 'latest' : n.version,
  }));
  return {
    baseImage: base?.baseImage ?? '',
    ansibleCore: base?.ansibleCore ?? '',
    collections,
    python: base?.python ?? [],
    system: base?.system ?? [],
  };
}
