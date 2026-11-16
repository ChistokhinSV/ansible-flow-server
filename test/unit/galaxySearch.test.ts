// Collection search (AFS-90): Galaxy's keyword search lists in no order of match and finds nothing
// for a dotted name, so a full name is looked up by namespace and name and results are ranked here.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { galaxyClient, rankCollections } from '../../src/server/environments/galaxy';

const found = (...names: string[]) => names.map((name) => ({ name, version: '1.0.0' }));

describe('rankCollections', () => {
  it('puts the collection named by the word before ones matched by description or tags', () => {
    const ranked = rankCollections(
      'fortios',
      found('fortinet.fortiswitch', 'fortinet.fortios', 'jiex19.fortios'),
    );
    expect(ranked.map((c) => c.name)).toEqual([
      'fortinet.fortios',
      'jiex19.fortios',
      'fortinet.fortiswitch',
    ]);
  });

  it('puts the name as typed first and lists each collection once', () => {
    const ranked = rankCollections(
      'fortinet.fortios',
      found('lix_fortinet.fortios', 'fortinet.fortiswitch', 'fortinet.fortios', 'fortinet.fortios'),
    );
    expect(ranked.map((c) => c.name)).toEqual([
      'fortinet.fortios',
      'lix_fortinet.fortios',
      'fortinet.fortiswitch',
    ]);
  });
});

describe('galaxyClient search', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubGalaxy(answer: (q: URLSearchParams) => string[]) {
    const asked: URLSearchParams[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      const q = new URL(url).searchParams;
      asked.push(q);
      const data = answer(q).map((full) => {
        const [namespace, name] = full.split('.');
        return { collection_version: { namespace, name, version: '2.0.0' } };
      });
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    return asked;
  }

  it('finds namespace.name by its namespace and name, not only by keywords', async () => {
    const asked = stubGalaxy((q) =>
      q.get('namespace') === 'fortinet' && q.get('name') === 'fortios' ? ['fortinet.fortios'] : [],
    );
    const result = await galaxyClient('https://galaxy.example.net').search?.('fortinet.fortios');
    expect(result?.map((c) => c.name)).toEqual(['fortinet.fortios']);
    expect(asked.map((q) => q.get('keywords')).filter(Boolean)).toEqual(['fortinet fortios']);
  });

  it('keeps what one lookup found when the other fails, and fails when all do', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      new URL(url).searchParams.has('keywords')
        ? new Response('', { status: 502 })
        : new Response(
            JSON.stringify({
              data: [{ collection_version: { namespace: 'a', name: 'fortios', version: '1.0.0' } }],
            }),
          ),
    );
    const client = galaxyClient('https://galaxy.example.net');
    expect((await client.search?.('fortios'))?.map((c) => c.name)).toEqual(['a.fortios']);
    await expect(client.search?.('two words')).rejects.toThrow(/answered 502/);
  });
});
