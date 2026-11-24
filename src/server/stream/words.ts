// AFS-248: why a destination failed, in words an administrator can act on. The library's code
// stays at the end, in brackets, for a search: on the page, in the audit log and in the
// stream.failing e-mail, "SELF_SIGNED_CERT_IN_CHAIN" alone said nothing (and was shown as "Not
// reachable" while the receiver was reachable).

const UNTRUSTED = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_UNTRUSTED',
  'CERT_SIGNATURE_FAILURE',
  'CERT_REJECTED',
]);
const NO_ANSWER = new Set(['ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN']);
const NOT_TLS = new Set([
  'EPROTO',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_PACKET_LENGTH_TOO_LONG',
  'ERR_SSL_HTTP_REQUEST',
]);

/**
 * Why sending to `where` (host:port, or a URL) failed. `e` is an error, or its code or message
 * when that is all there is.
 */
export function problemOf(e: unknown, where?: string): string {
  const err = typeof e === 'string' ? { code: e, message: e } : (e as NodeJS.ErrnoException);
  const code = err?.code ?? '';
  const message = err?.message ?? String(e);
  const at = where ? ` ${where}` : '';
  const tag = code ? ` (${code})` : '';
  if (UNTRUSTED.has(code))
    return `Its certificate is not trusted: add the authority (CA) that signed it${tag}`;
  if (code === 'CERT_HAS_EXPIRED') return `Its certificate has expired${tag}`;
  if (code === 'CERT_NOT_YET_VALID') return `Its certificate is not valid yet${tag}`;
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID')
    return `Its certificate is for another name: use the name it was made for${tag}`;
  if (NOT_TLS.has(code))
    return `No TLS answer: is this the TLS port of${at || ' the receiver'}?${tag}`;
  if (code === 'ECONNREFUSED')
    return `Nothing listens on${at || ' that port'}: check the port, and that the receiver is up${tag}`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `The host name is not known${tag}`;
  if (NO_ANSWER.has(code) || /connect timeout/i.test(message))
    return `Not reachable: no answer from${at || ' the receiver'}${tag}`;
  if (code === 'ECONNRESET' || code === 'EPIPE') return `The receiver closed the connection${tag}`;
  if (code.startsWith('HPE_'))
    return `The answer is not HTTP: OTLP/HTTP is usually on port 4318 (4317 is gRPC)${tag}`;
  return message || code || 'Unknown error';
}
