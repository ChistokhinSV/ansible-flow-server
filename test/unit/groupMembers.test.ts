// Setting a group's members by hand keeps where each membership came from (AFS-283): a member an
// OIDC provider or LDAP directory gave stays that source's, so the source can still take it back.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySource } from '../../src/server/auth/external';
import { createGroup, createUser, getGroup, setMembers } from '../../src/server/auth/users';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';

const SOURCE = 'oidc:lab';

describe('group members set by hand', () => {
  let database: Database;
  let group: string;
  let sam: string;
  let olga: string;

  beforeAll(async () => {
    database = openDatabase({ kind: 'sqlite', file: ':memory:' });
    await migrate(database.db as never);
    sam = (await createUser(database.db, { login: 'sam.reyes', name: 'Sam Reyes' })).id;
    olga = (await createUser(database.db, { login: 'olga', name: 'Olga' })).id;
    group = (await createGroup(database.db, { name: 'net-ops' })).id;
  });
  afterAll(() => database.close());

  const sources = async () =>
    Object.fromEntries(
      (
        await database.db
          .selectFrom('group_member')
          .select(['user_id', 'source'])
          .where('group_id', '=', group)
          .execute()
      ).map((r) => [r.user_id, r.source ?? null]),
    );

  it("keeps a provider member as the provider's, adds the new one by hand", async () => {
    await database.db
      .transaction()
      .execute((trx) => applySource(trx, sam, SOURCE, new Set([group]), false));
    await setMembers(database.db, group, [sam, olga]);
    expect(await sources()).toEqual({ [sam]: SOURCE, [olga]: null });
  });

  it('lets the provider take its member back afterwards; the one added by hand stays', async () => {
    await database.db
      .transaction()
      .execute((trx) => applySource(trx, sam, SOURCE, new Set(), false));
    expect((await getGroup(database.db, group))?.members).toEqual(['olga']);
  });

  it('removes whoever is left out, whatever gave the membership', async () => {
    await database.db
      .transaction()
      .execute((trx) => applySource(trx, sam, SOURCE, new Set([group]), false));
    await setMembers(database.db, group, [sam]);
    expect(await sources()).toEqual({ [sam]: SOURCE });
    await setMembers(database.db, group, []);
    expect(await sources()).toEqual({});
  });
});
