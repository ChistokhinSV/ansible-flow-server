// Starts the server and says how to stop it. main.ts calls it with the settings and stops it on a
// signal; tests call it with their own.
import { buildApp } from './app';
import { type Config, withoutPassword } from './config';
import { openDatabase } from './db/database';
import { migrate } from './db/migrations';
import { instanceId } from './db/settings';
import type { Logger } from './log';
import { serverMeta } from './meta';

export interface RunningServer {
  /** The address it answers at, as a URL. */
  url: string;
  /**
   * Stops it in order: no new requests, the ones in flight finish, the database is closed.
   * Resolves once all of it is done; a second call waits for the first.
   */
  stop(why: string): Promise<void>;
}

/** Rejects when the server cannot start; whatever it had opened by then is closed again. */
export async function startServer(config: Config, log: Logger): Promise<RunningServer> {
  const meta = serverMeta();
  log.info({ version: meta.version, designer: meta.designer.version }, `${meta.name} starts`);
  const database = openDatabase(config.database);
  let app: ReturnType<typeof buildApp> | undefined;
  try {
    await database.ping();
    const applied = await migrate(database.db as never);
    log.info(
      {
        kind: database.kind,
        where:
          config.database.kind === 'sqlite'
            ? config.database.file
            : withoutPassword(config.database.url),
        changes: applied.length,
      },
      'Database ready',
    );
    app = buildApp({ log, database, instance: await instanceId(database.db) });
    const url = await app.listen({ host: config.host, port: config.port });
    let stopping: Promise<void> | undefined;
    return {
      url,
      stop(why) {
        stopping ??= (async () => {
          log.info({ why }, 'Shutting down');
          await app?.close();
          await database.close();
          log.info('Stopped');
        })();
        return stopping;
      },
    };
  } catch (e) {
    await app?.close().catch(() => undefined);
    await database.close().catch(() => undefined);
    throw e;
  }
}
