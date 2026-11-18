// The server's default image (AFS-163): what runs get when their launch configuration names no
// environment or image. An administrator picks an environment for it (kept in the settings
// table); without one, or while the one picked has no image, it is AFS_EE_IMAGE.
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';
import { getSetting, setSetting } from '../db/settings';
import { environmentImage } from './image';

const SETTING = 'ee.default.environment';
/** What AFS_EE_IMAGE is when it is not set (config.ts). */
export const DEFAULT_EE_IMAGE = 'ghcr.io/ansible/community-ansible-dev-tools:latest';

export interface ServerDefault {
  /** The image runs without their own get now. */
  image: string;
  /** AFS_EE_IMAGE: the image when no environment is picked, or the picked one has none. */
  configured: string;
  /** The environment picked, when one is. */
  environment?: { id: string; name: string; workspace: string; workspaceKey?: string };
  /** Why the picked environment's image is not used (not built yet, gone, could not be pulled). */
  why?: string;
}

export async function serverDefault(
  db: Kysely<Schema>,
  configured: string,
): Promise<ServerDefault> {
  const id = await getSetting(db, SETTING);
  if (!id) return { image: configured, configured };
  const env = await environmentImage(db, id);
  if (!env.name || !env.workspace)
    return { image: configured, configured, why: 'The environment picked is gone' };
  const ws = await db
    .selectFrom('workspace')
    .select('key')
    .where('id', '=', env.workspace)
    .executeTakeFirst();
  return {
    image: env.image ?? configured,
    configured,
    environment: {
      id,
      name: env.name,
      workspace: env.workspace,
      ...(ws ? { workspaceKey: ws.key } : {}),
    },
    ...(env.image ? {} : { why: env.why ?? 'The environment has no image yet' }),
  };
}

/** Picks the environment (its image as it is built again), or null for AFS_EE_IMAGE. */
export async function setServerDefault(db: Kysely<Schema>, id: string | null): Promise<boolean> {
  if (id) {
    const env = await db
      .selectFrom('environment')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!env) return false;
  }
  // An empty value is no environment: the settings table keeps names, not their absence.
  await setSetting(db, SETTING, id ?? '');
  return true;
}

/** Whether an environment is the server's default (its deletion is then refused). */
export async function isServerDefault(db: Kysely<Schema>, id: string): Promise<boolean> {
  return (await getSetting(db, SETTING)) === id;
}
