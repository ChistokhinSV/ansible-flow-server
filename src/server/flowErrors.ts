// AFS-164: a flow that cannot run says which errors stop it and where they are, not only how
// many. Shared by the server (the message) and the pages (the list with a link to each step).

/** One error of a flow: the step it is on (by id and title), and what is wrong. */
export interface FlowError {
  message: string;
  /** The step's id, to select it on the canvas; none for an error of the flow itself. */
  node?: string;
  /** The step's title. */
  step?: string;
}

/** How many errors a message names before "and N more". */
export const NAMED = 3;

/** "The flow has 2 errors, so it cannot run until they are fixed" */
export function errorsLead(count: number): string {
  return count === 1
    ? 'The flow has 1 error, so it cannot run until it is fixed'
    : `The flow has ${count} errors, so it cannot run until they are fixed`;
}

/** One error in a few words: "Ping: no module is bound". */
export function errorWords(error: FlowError): string {
  const message = error.message.trim().replace(/\.$/, '');
  return error.step ? `${error.step}: ${message}` : message;
}

/**
 * The message of a flow with errors: the first few named, then how many more.
 * `count` is every error; `errors` may hold fewer.
 */
export function errorsSentence(count: number, errors: FlowError[]): string {
  const named = errors.slice(0, NAMED).map(errorWords);
  if (!named.length) return errorsLead(count);
  const more = count - named.length;
  return `${errorsLead(count)}: ${named.join('; ')}${more > 0 ? `; and ${more} more` : ''}.`;
}
