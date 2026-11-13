// Who a notification goes to, and where (AFS-29). Names are logins and group names, as a flow's
// approval and a launch configuration name them. A person is told at their email address and their
// webhook; a group at its own, or, when it has neither, through each of its members. Disabled
// accounts are told nothing; an address reached two ways is told once.
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';
import type { Outgoing } from './store';

type Db = Kysely<Schema>;

interface Contact {
  label: string;
  email: string | null;
  webhook_url: string | null;
}

/** The places of these contacts, each address once. */
export function placesOf(contacts: Contact[]): Outgoing[] {
  const out = new Map<string, Outgoing>();
  for (const c of contacts) {
    if (c.email) {
      const target = c.email.trim();
      out.set(`email|${target.toLowerCase()}`, { channel: 'email', recipient: c.label, target });
    }
    if (c.webhook_url) {
      const target = c.webhook_url.trim();
      out.set(`webhook|${target}`, { channel: 'webhook', recipient: c.label, target });
    }
  }
  return [...out.values()];
}

async function usersById(db: Db, ids: string[]): Promise<Contact[]> {
  if (!ids.length) return [];
  const rows = await db
    .selectFrom('user_account')
    .select(['login', 'email', 'webhook_url'])
    .where('id', 'in', ids)
    .where('disabled', '=', 0)
    .execute();
  return rows.map((r) => ({ label: r.login, email: r.email, webhook_url: r.webhook_url }));
}

async function groupContacts(db: Db, groupIds: string[]): Promise<Contact[]> {
  if (!groupIds.length) return [];
  const groups = await db
    .selectFrom('user_group')
    .select(['id', 'name', 'email', 'webhook_url'])
    .where('id', 'in', groupIds)
    .execute();
  const out: Contact[] = [];
  for (const g of groups) {
    if (g.email || g.webhook_url) {
      out.push({ label: g.name, email: g.email, webhook_url: g.webhook_url });
      continue;
    }
    const members = await db
      .selectFrom('group_member')
      .select('user_id')
      .where('group_id', '=', g.id)
      .execute();
    out.push(
      ...(await usersById(
        db,
        members.map((m) => m.user_id),
      )),
    );
  }
  return out;
}

/** Contacts of logins and group names; names that are neither are left out. */
export async function contactsOfNames(db: Db, names: string[]): Promise<Contact[]> {
  const wanted = [...new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))];
  if (!wanted.length) return [];
  const users = await db
    .selectFrom('user_account')
    .select(['id', 'login'])
    .where('login', 'in', wanted)
    .execute();
  const groups = (await db.selectFrom('user_group').select(['id', 'name']).execute()).filter((g) =>
    wanted.includes(g.name.toLowerCase()),
  );
  return [
    ...(await usersById(
      db,
      users.map((u) => u.id),
    )),
    ...(await groupContacts(
      db,
      groups.map((g) => g.id),
    )),
  ];
}

/** Of these names, the ones that are no login and no group's name. */
export async function unknownNames(db: Db, names: string[]): Promise<string[]> {
  const lower = names.map((n) => n.trim().toLowerCase());
  const users = new Set(
    (
      await db
        .selectFrom('user_account')
        .select('login')
        .where('login', 'in', lower.length ? lower : [''])
        .execute()
    ).map((u) => u.login),
  );
  const groups = new Set(
    (await db.selectFrom('user_group').select('name').execute()).map((g) => g.name.toLowerCase()),
  );
  return names.filter((_, i) => !users.has(lower[i] as string) && !groups.has(lower[i] as string));
}

/**
 * Who holds the approve grant on a flow, or on its workspace: whoever may decide its approvals
 * when the approval names nobody. Administrators are not among them unless a grant names them:
 * they may decide everything, and would be told of everything.
 */
export async function approverContacts(
  db: Db,
  place: { workspace: string; project: string; flowFile: string },
  except?: string,
): Promise<Contact[]> {
  const grants = await db
    .selectFrom('access_grant')
    .select(['principal_type', 'principal_id'])
    .where('level', '=', 'approve')
    .where('workspace_id', '=', place.workspace)
    .where((eb) =>
      eb.or([
        eb('project_id', 'is', null),
        eb.and([eb('project_id', '=', place.project), eb('flow_file', '=', place.flowFile)]),
      ]),
    )
    .execute();
  const users = grants.filter((g) => g.principal_type === 'user').map((g) => g.principal_id);
  const groups = grants.filter((g) => g.principal_type === 'group').map((g) => g.principal_id);
  const exceptLogin = except
    ? (
        await db
          .selectFrom('user_account')
          .select('login')
          .where('id', '=', except)
          .executeTakeFirst()
      )?.login
    : undefined;
  return [
    ...(await usersById(
      db,
      users.filter((u) => u !== except),
    )),
    ...(await groupContacts(db, groups)),
  ].filter((c) => !exceptLogin || c.label !== exceptLogin);
}

/** The administrators: told of what concerns the server (its certificate). */
export async function adminContacts(db: Db): Promise<Contact[]> {
  const rows = await db
    .selectFrom('user_account')
    .select(['login', 'email', 'webhook_url'])
    .where('is_admin', '=', 1)
    .where('disabled', '=', 0)
    .execute();
  return rows.map((r) => ({ label: r.login, email: r.email, webhook_url: r.webhook_url }));
}

/** Who launched a run, when they are still there. */
export async function launcherContacts(db: Db, userId: string): Promise<Contact[]> {
  return usersById(db, [userId]);
}
