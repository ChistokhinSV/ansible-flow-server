// Sealing a secret for the database, and opening it again. AES-256-GCM with a fresh nonce per
// value; the value is bound to where it is kept (`context`, such as "credential:<id>"), so a
// sealed value copied to another row does not open there.
//   v1.<key id>.<nonce>.<ciphertext>.<tag>      each part base64url
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { MasterKey } from './masterKey';

export class SealError extends Error {
  constructor(
    readonly code: 'other_key' | 'damaged',
    message: string,
  ) {
    super(message);
    this.name = 'SealError';
  }
}

const b64 = (bytes: Buffer) => bytes.toString('base64url');

export function seal(key: MasterKey, text: string, context: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key.key, nonce);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const sealed = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return ['v1', key.id, b64(nonce), b64(sealed), b64(cipher.getAuthTag())].join('.');
}

/** The id of the key a sealed value needs; undefined when the text is not a sealed value. */
export function sealedWith(sealed: string): string | undefined {
  const parts = sealed.split('.');
  return parts.length === 5 && parts[0] === 'v1' ? parts[1] : undefined;
}

/**
 * Opens a sealed value. Throws a SealError that says whether the key is another one, or the
 * value is damaged or was moved from where it was sealed; never anything of the value.
 */
export function open(key: MasterKey, sealed: string, context: string): string {
  const [version, id, nonce, body, tag] = sealed.split('.');
  if (version !== 'v1' || !id || !nonce || body === undefined || !tag)
    throw new SealError('damaged', 'Not a sealed value');
  if (id !== key.id)
    throw new SealError(
      'other_key',
      `Sealed with another master key (${id}); the server has ${key.id}`,
    );
  try {
    const decipher = createDecipheriv('aes-256-gcm', key.key, Buffer.from(nonce, 'base64url'));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(body, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new SealError('damaged', 'The sealed value is damaged, or is not where it was sealed');
  }
}
