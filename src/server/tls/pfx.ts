// AFS-55: a server certificate from a PFX (PKCS#12) file, as Windows certificate authorities and
// many appliances hand them out: taken apart into the certificate, its chain and its key, which
// then go through the same checks as a PEM pair. node-forge decrypts the file (modern AES-256 and
// the legacy 3DES and RC2 ones); Node's own crypto reads the key and certificates, so an EC key
// is read as well as an RSA one. The passphrase is used here and kept nowhere.
import { createPrivateKey, X509Certificate } from 'node:crypto';
import forge from 'node-forge';
import { CertificateRefused } from './store';

/** A PFX is no larger than this: a certificate, its chain and a key. */
export const PFX_MAX = 256 * 1024;

const derOf = (asn1: forge.asn1.Asn1) => Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');

/** True when the bytes look like a PFX (DER), not a PEM text. */
export function isPfx(bytes: Buffer): boolean {
  return (
    bytes.length > 0 &&
    bytes[0] === 0x30 &&
    !bytes.subarray(0, 64).toString('latin1').includes('-----BEGIN')
  );
}

/** The certificate (with the chain after it) and the key in a PFX, as PEM. */
export function pfxToPem(bytes: Buffer, passphrase: string): { certificate: string; key: string } {
  if (bytes.length > PFX_MAX)
    throw new CertificateRefused([`The PFX is larger than ${PFX_MAX / 1024} KB`]);
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(bytes.toString('binary')), passphrase);
  } catch (e) {
    const why = (e as Error).message;
    throw new CertificateRefused([
      /MAC|password|decrypt/i.test(why)
        ? 'The PFX passphrase is wrong (or the file is damaged)'
        : 'The file is not a PFX (PKCS#12) file this server can read',
    ]);
  }
  const bagsOf = (type: string) => p12.getBags({ bagType: type })[type] ?? [];
  const keyBags = [
    ...bagsOf(forge.pki.oids.pkcs8ShroudedKeyBag as string),
    ...bagsOf(forge.pki.oids.keyBag as string),
  ];
  // RSA keys come as objects; others (EC) stay as the decrypted PrivateKeyInfo.
  const keys = keyBags.map((b) =>
    createPrivateKey({
      key: b.key
        ? derOf(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(b.key)))
        : derOf(b.asn1 as forge.asn1.Asn1),
      format: 'der',
      type: 'pkcs8',
    }),
  );
  if (!keys.length) throw new CertificateRefused(['The PFX holds no private key']);
  if (keys.length > 1)
    throw new CertificateRefused(['The PFX holds several private keys: export one certificate']);
  const key = keys[0] as ReturnType<typeof createPrivateKey>;
  const certs = bagsOf(forge.pki.oids.certBag as string).map(
    (b) =>
      new X509Certificate(
        b.cert ? derOf(forge.pki.certificateToAsn1(b.cert)) : derOf(b.asn1 as forge.asn1.Asn1),
      ),
  );
  const leaf = certs.find((c) => c.checkPrivateKey(key));
  if (!leaf) throw new CertificateRefused(['No certificate in the PFX belongs to its private key']);
  // The chain in order: each certificate followed by the one that issued it.
  const chain: X509Certificate[] = [];
  let at = leaf;
  const rest = certs.filter((c) => c !== leaf);
  for (;;) {
    const issuer = rest.find((c) => !chain.includes(c) && at.checkIssued(c) && c !== at);
    if (!issuer || issuer.subject === at.subject) break;
    chain.push(issuer);
    at = issuer;
  }
  // Certificates that are not on the leaf's chain are left out.
  return {
    certificate: [leaf, ...chain].map((c) => c.toString()).join(''),
    key: key.export({ type: 'pkcs8', format: 'pem' }) as string,
  };
}
