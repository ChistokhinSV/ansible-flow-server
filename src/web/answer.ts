// AFS-171: what an answer of the server means when it says no more than its number (a proxy's
// page, a server that failed before it could say why): what happened and what to do, in words.

/** Words for an answer that came with no message of its own. */
export function answerWords(status: number): string {
  if (status === 400)
    return 'The server could not take what was sent (400): check what you entered and try again.';
  if (status === 401) return 'You are signed out (401): sign in again.';
  if (status === 403)
    return 'You may not do this here (403): an administrator can give you the access it needs.';
  if (status === 404)
    return 'It is not here (404): it was removed, or is not shared with you. Reload the page.';
  if (status === 409)
    return 'It changed meanwhile (409): reload the page to see it as it is now, then try again.';
  if (status === 413) return 'That is too large for the server (413): send something smaller.';
  if (status === 422)
    return 'The server cannot do this now (422): what it is about is not in a state that allows it. Reload the page to see why.';
  if (status === 429) return 'Too many tries (429): wait a minute and try again.';
  if (status === 502 || status === 503 || status === 504)
    return `The server is not reachable just now (${status}): it may be starting or busy. Try again in a minute.`;
  if (status >= 500)
    return `The server failed (${status}): try again. If it keeps failing, an administrator can look at the server's log.`;
  return `The server answered ${status}: try again.`;
}
