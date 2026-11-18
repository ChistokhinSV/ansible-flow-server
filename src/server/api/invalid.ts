// AFS-140: a request the schema refused, said in plain words about the field, not in the schema
// library's ("body/name must NOT have more than 200 characters"). The field goes with it, so a page
// shows the words at the field they are about.

interface SchemaProblem {
  instancePath?: string;
  keyword?: string;
  params?: Record<string, unknown>;
  message?: string;
}

/** `privateKey` -> "Private key", `gitUrl` -> "Git URL". */
export function fieldLabel(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .replace(/\b(url|uri|id|ssh|awx|dn|smtp|tls|ca)\b/g, (w) => w.toUpperCase());
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The field a schema problem is about: its last named part (a list's place is no name). */
function fieldOf(problem: SchemaProblem): string | undefined {
  const missing = problem.params?.missingProperty;
  const parts = (problem.instancePath ?? '').split('/').filter((p) => p && !/^\d+$/.test(p));
  if (typeof missing === 'string') return missing;
  return parts.at(-1);
}

const plural = (n: unknown, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The first schema problem in words; the field it is about when there is one. */
export function plainInvalid(problems: readonly SchemaProblem[]): {
  message: string;
  field?: string;
} {
  const problem = problems[0] ?? {};
  const field = fieldOf(problem);
  const label = field ? fieldLabel(field) : 'The request';
  const p = problem.params ?? {};
  let words: string;
  switch (problem.keyword) {
    case 'required':
      words = `${label} is needed.`;
      break;
    case 'minLength':
      words =
        p.limit === 1
          ? `${label} is needed.`
          : `${label}: at least ${plural(p.limit, 'character')}.`;
      break;
    case 'maxLength':
      words = `${label}: at most ${plural(p.limit, 'character')}.`;
      break;
    case 'minItems':
      words = `${label}: at least ${p.limit}.`;
      break;
    case 'maxItems':
      words = `${label}: at most ${p.limit}.`;
      break;
    case 'minimum':
      words = `${label}: at least ${p.limit}.`;
      break;
    case 'maximum':
      words = `${label}: at most ${p.limit}.`;
      break;
    case 'enum':
      words = Array.isArray(p.allowedValues)
        ? `${label}: one of ${p.allowedValues.join(', ')}.`
        : `${label} is not one of the choices.`;
      break;
    case 'pattern':
    case 'format':
      words = `${label} is not in the right form.`;
      break;
    case 'additionalProperties':
      return {
        message: `${typeof p.additionalProperty === 'string' ? fieldLabel(p.additionalProperty) : 'A field'} is not known here.`,
      };
    case 'type':
      words = `${label} is not the right kind of value.`;
      break;
    default:
      words = `${label} is not right.`;
  }
  return field ? { message: words, field } : { message: words };
}
