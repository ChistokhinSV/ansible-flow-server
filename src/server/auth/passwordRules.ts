// AFS-140: what a password must be. Values only, no server code: the pages state the rules under
// a password field and check them before sending; the server checks them again.

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;

/** The rules in one sentence, as a password field's hint. */
export const PASSWORD_RULES = `At least ${PASSWORD_MIN} characters, at least 5 different ones, and not containing the login. A few words work well.`;

/** Why a password is not accepted, for the person choosing it; undefined when it is. */
export function passwordProblem(password: string, login?: string): string | undefined {
  if (password.length < PASSWORD_MIN) return `A password has at least ${PASSWORD_MIN} characters`;
  if (password.length > PASSWORD_MAX) return `A password has at most ${PASSWORD_MAX} characters`;
  if (login && password.toLowerCase().includes(login.toLowerCase()))
    return 'A password does not contain the login';
  if (new Set(password).size < 5) return 'A password uses more than a few different characters';
  return undefined;
}
