// `backup` and `restore` (AFS-37) on the command line:
//   backup <file.tar.gz> [--with-key]   while the server runs
//   restore <file.tar.gz> [--force]     with the server stopped
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { recordAudit } from '../audit/store';
import type { Config } from '../config';
import { openDatabase } from '../db/database';
import { BackupError, backup, restore } from './backup';

const osUser = () => {
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
};

async function audit(config: Config, action: string, detail: Record<string, unknown>) {
  const database = openDatabase(config.database);
  try {
    await recordAudit(database.db, {
      actor: null,
      source: 'cli',
      action,
      object: { type: 'server' },
      result: 'ok',
      detail: { ...detail, osUser: osUser() },
    });
  } catch (e) {
    console.error(`The audit log could not be written: ${(e as Error).message}`);
  } finally {
    await database.close().catch(() => undefined);
  }
}

const USAGE = {
  backup: 'backup <file.tar.gz> [--with-key]',
  restore: 'restore <file.tar.gz> [--force]',
};

export async function opsCommand(
  config: Config,
  command: 'backup' | 'restore',
  args: string[],
): Promise<number> {
  const file = args.find((a) => !a.startsWith('--'));
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const allowed = command === 'backup' ? ['--with-key'] : ['--force'];
  const odd = [...flags].find((f) => !allowed.includes(f));
  if (!file || odd) {
    console.error(`${odd ? `Unknown option ${odd}. ` : ''}Use: ${USAGE[command]}`);
    return 2;
  }
  const path = resolve(file);
  try {
    if (command === 'backup') {
      const { manifest } = await backup(config, path, { withKey: flags.has('--with-key') });
      const rows = manifest.tables.reduce((n, t) => n + t.rows, 0);
      console.log(`Backup written: ${path}`);
      console.log(
        `  ${manifest.database} database, ${rows} rows in ${manifest.tables.length} tables; folders: ${manifest.folders.join(', ') || 'none'}`,
      );
      if (manifest.withKey)
        console.log(
          '  It holds the master key: keep it as safely as every credential it can open.',
        );
      else if (manifest.keyId)
        console.log(
          `  The master key (${manifest.keyId}) is not in it: keep a copy of the key apart; without it the credentials cannot be read after a restore.`,
        );
      await audit(config, 'server.backup', { file: path, withKey: manifest.withKey, rows });
      return 0;
    }
    const result = await restore(config, path, { force: flags.has('--force') });
    console.log(`Restored ${path}`);
    console.log(
      `  made ${result.manifest.createdAt} by server ${result.manifest.server} on ${result.manifest.database}; ${result.rows} rows into ${config.database.kind}`,
    );
    if (result.migrated.length)
      console.log(`  then brought up to this server: ${result.migrated.length} database changes`);
    if (result.keyFile) console.log(`  master key written to ${result.keyFile}`);
    await audit(config, 'server.restore', {
      file: path,
      from: result.manifest.createdAt,
      rows: result.rows,
    });
    return 0;
  } catch (e) {
    console.error(
      e instanceof BackupError ? e.message : `The ${command} failed: ${(e as Error).message}`,
    );
    return 1;
  }
}
