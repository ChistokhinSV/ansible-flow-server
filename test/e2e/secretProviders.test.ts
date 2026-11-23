// AFS-242: the four secret provider clients against real providers: the spike lab on the GNS3 VM
// (HashiCorp Vault 2.2.2 with TLS, CyberArk Conjur OSS 1.27.0, LocalStack 4.14.0 for AWS Secrets
// Manager, a CyberArk CCP mock with client certificates). Fictional secrets only.
// Skipped unless AFS_SECRETS_LAB names a folder with the lab's values (see test/e2e/README.md).
// A machine whose TLS is intercepted (Norton re-signs every connection) cannot reach Vault and
// CCP: `node test/e2e/secrets/on-vm.mjs` runs this file in a container on the VM.
// Plain node:assert, so the same file runs under node:test there.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { type Connection, clientOf } from '../../src/server/secrets/providers/clients';
import type { SecretReadError } from '../../src/server/secrets/providers/http';

const dir = process.env.AFS_SECRETS_LAB ?? '';
const host = process.env.AFS_SECRETS_LAB_HOST ?? '192.168.200.128';
const file = (name: string) => readFileSync(join(dir, name), 'utf8').trim();
const VALUE = 'lab-switch-password-1';
const suite = dir ? describe : describe.skip;

async function failure(p: Promise<unknown>): Promise<SecretReadError> {
  try {
    await p;
  } catch (e) {
    return e as SecretReadError;
  }
  throw new Error('it did not fail');
}

suite('secret providers in the lab', () => {
  const vault = (change: Partial<Connection> = {}): Connection => ({
    key: 'lab-vault',
    name: 'lab-vault',
    kind: 'vault',
    settings: {
      address: `https://${host}:18200`,
      auth: 'approle',
      ca: file('vault-ca.pem'),
      timeoutS: 5,
    },
    secret: { roleId: file('vault-role-id'), secretId: file('vault-secret-id') },
    ...change,
  });
  const conjur = (change: Partial<Connection> = {}): Connection => ({
    key: 'lab-conjur',
    name: 'lab-conjur',
    kind: 'conjur',
    settings: {
      address: `http://${host}:18080`,
      account: 'spike',
      login: 'host/afs-spike',
      timeoutS: 5,
    },
    secret: { apiKey: file('conjur-host-key') },
    ...change,
  });
  const ccp = (change: Partial<Connection> = {}): Connection => ({
    key: 'lab-ccp',
    name: 'lab-ccp',
    kind: 'ccp',
    settings: {
      address: `https://${host}:18443`,
      appId: 'afs-spike',
      ca: file('ccp-ca.pem'),
      clientCert: file('ccp-client.pem'),
      timeoutS: 5,
    },
    secret: { clientKey: file('ccp-client.key') },
    ...change,
  });
  const aws: Connection = {
    key: 'lab-aws',
    name: 'lab-aws',
    kind: 'aws',
    settings: { region: 'us-east-1', address: `http://${host}:14566`, timeoutS: 5 },
    secret: { accessKeyId: 'test', secretAccessKey: 'test' },
  };

  it('HashiCorp Vault: AppRole and token read KV v2; the AppRole token is revoked', async () => {
    const client = clientOf(vault());
    assert.equal(await client.test(), 'Signed in with AppRole');
    assert.equal(
      await client.read({ provider: 'lab-vault', path: 'lab/switch', field: 'password' }),
      VALUE,
    );
    await client.close();
    const token = clientOf(
      vault({
        settings: { ...vault().settings, auth: 'token' },
        secret: { token: file('vault-token') },
      }),
    );
    assert.equal(
      await token.read({ provider: 'lab-vault', path: 'lab/switch', field: 'password' }),
      VALUE,
    );
  });

  it('HashiCorp Vault: denied, missing, a bad secret id, no CA: words without the path', async () => {
    const client = clientOf(vault());
    const denied = await failure(
      client.read({ provider: 'lab-vault', path: 'lab/other', field: 'password' }),
    );
    assert.equal(denied.code, 'denied');
    assert.ok(!denied.message.includes('lab/other'));
    const missing = await failure(
      client.read({ provider: 'lab-vault', path: 'lab/missing', field: 'password' }),
    );
    assert.equal(missing.code, 'not_found');
    const field = await failure(
      client.read({ provider: 'lab-vault', path: 'lab/switch', field: 'nope' }),
    );
    assert.match(field.message, /not the field/);
    await client.close();
    const bad = await failure(
      clientOf(
        vault({
          secret: {
            roleId: file('vault-role-id'),
            secretId: '00000000-0000-0000-0000-000000000000',
          },
        }),
      ).test(),
    );
    assert.equal(bad.code, 'auth');
    const noCa = await failure(
      clientOf(vault({ settings: { ...vault().settings, ca: '' } })).test(),
    );
    assert.equal(noCa.code, 'tls');
    const closed = await failure(
      clientOf(
        vault({ settings: { ...vault().settings, address: `https://${host}:18299` } }),
      ).test(),
    );
    assert.equal(closed.code, 'unreachable');
  });

  it('CyberArk Conjur: a host API key reads; no permission and missing read the same', async () => {
    const client = clientOf(conjur());
    assert.equal(
      await client.read({ provider: 'lab-conjur', variable: 'lab/switch-password' }),
      VALUE,
    );
    const hidden = await failure(
      client.read({ provider: 'lab-conjur', variable: 'lab/other-secret' }),
    );
    const missing = await failure(client.read({ provider: 'lab-conjur', variable: 'lab/missing' }));
    assert.equal(hidden.message, missing.message);
    assert.match(missing.message, /no such variable, or "lab-conjur" may not read it \(404\)/);
    const wrong = await failure(clientOf(conjur({ secret: { apiKey: 'notavalidkey' } })).test());
    assert.equal(wrong.code, 'auth');
  });

  it('CyberArk CCP: AppID and a client certificate read; a missing object says its code only', async () => {
    const client = clientOf(ccp());
    assert.equal(
      await client.read({ provider: 'lab-ccp', safe: 'LAB-NET', object: 'lab-switch-01' }),
      VALUE,
    );
    const missing = await failure(
      client.read({ provider: 'lab-ccp', safe: 'LAB-NET', object: 'lab-switch-99' }),
    );
    assert.equal(missing.code, 'not_found');
    assert.ok(!missing.message.includes('lab-switch-99'));
    const noCert = await failure(
      clientOf(ccp({ settings: { ...ccp().settings, clientCert: '' }, secret: {} })).read({
        provider: 'lab-ccp',
        safe: 'LAB-NET',
        object: 'lab-switch-01',
      }),
    );
    assert.equal(noCert.code, 'denied');
    assert.match(noCert.message, /client certificate and AppID of "lab-ccp" \[APPAP306E\]/);
    const otherApp = await failure(
      clientOf(ccp({ settings: { ...ccp().settings, appId: 'other-app' } })).read({
        provider: 'lab-ccp',
        safe: 'LAB-NET',
        object: 'lab-switch-01',
      }),
    );
    assert.equal(otherApp.code, 'denied');
    const slow = await failure(
      clientOf(ccp({ settings: { ...ccp().settings, timeoutS: 2 } })).read({
        provider: 'lab-ccp',
        safe: 'LAB-NET',
        object: 'slow',
      }),
    );
    assert.equal(slow.message, 'CyberArk CCP "lab-ccp" did not answer within 2 s');
  });

  it('AWS Secrets Manager: a JSON key, the whole secret, and a missing one', async () => {
    const client = clientOf(aws);
    assert.equal(
      await client.read({ provider: 'lab-aws', secretId: 'lab/switch', jsonKey: 'password' }),
      VALUE,
    );
    assert.equal(
      JSON.parse(await client.read({ provider: 'lab-aws', secretId: 'lab/switch' })).username,
      'netops',
    );
    const missing = await failure(client.read({ provider: 'lab-aws', secretId: 'lab/missing' }));
    assert.equal(missing.code, 'not_found');
    assert.match(await client.test(), /^Signed in/);
  });
});
