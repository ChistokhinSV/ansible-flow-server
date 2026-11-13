// The server's entry.
//   node dist/server.js                 start the server
//   node dist/server.js check <flows>   read flow files and say what they are (no server)
//   node dist/server.js cert <command>  the server's certificate (tls/cli.ts)
//   node dist/server.js user <command>  the people who sign in (auth/cli.ts)
import { existsSync, readFileSync } from 'node:fs';
import { userCommand } from './auth/cli';
import { type Config, ConfigError, loadConfig } from './config';
import { openDatabase } from './db/database';
import { migrate } from './db/migrations';
import { summarizeFlow } from './flows';
import { createLogger } from './log';
import { serverMeta } from './meta';
import { type RunningServer, startServer } from './serve';
import { certCommand } from './tls/cli';

/** How long a shutdown may take before the process ends anyway. */
const SHUTDOWN_MS = 15_000;

function checkFlows(files: string[]): number {
  const meta = serverMeta();
  console.log(
    `${meta.name} ${meta.version}, built on Ansible Flow Designer ${meta.designer.version}; reads flows up to format ${meta.designer.format}`,
  );
  let failed = false;
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (e) {
      console.error(`${file}: ${(e as Error).message}`);
      failed = true;
      continue;
    }
    const flow = summarizeFlow(file, text);
    if (!flow.ok) {
      console.error(`${file}: ${flow.problem}`);
      failed = true;
    } else {
      console.log(
        `${file}: ${flow.name} (${flow.key} v${flow.version}, format ${flow.format}), ${flow.steps} steps, ${flow.errors} errors, ${flow.warnings} warnings`,
      );
    }
  }
  return failed ? 1 : 0;
}

/** The settings, from a .env file beside the server if there is one; the environment wins. */
function settings(): Config | undefined {
  const envFile = process.env.AFS_ENV_FILE ?? '.env';
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  try {
    return loadConfig();
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : e);
    process.exitCode = 2;
    return undefined;
  }
}

async function serve(config: Config): Promise<void> {
  const log = createLogger(config.log);
  let server: RunningServer;
  try {
    server = await startServer(config, log);
  } catch (e) {
    log.fatal({ err: e }, 'The server could not start');
    process.exitCode = 1;
    return;
  }
  const stop = (signal: string) => {
    // A request or a connection that will not end must not keep the process: it ends anyway.
    const timer = setTimeout(() => {
      log.error({ after_ms: SHUTDOWN_MS }, 'Shutdown took too long: ending now');
      process.exit(1);
    }, SHUTDOWN_MS);
    timer.unref();
    server.stop(signal).catch((e) => {
      log.error({ err: e }, 'Shutdown did not finish cleanly');
      process.exitCode = 1;
    });
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

/** A user command works on the database directly, with or without a server running. */
async function users(config: Config, args: string[]): Promise<number> {
  const database = openDatabase(config.database);
  try {
    await migrate(database.db as never);
    return await userCommand(database.db, args);
  } catch (e) {
    console.error(`The database could not be used: ${(e as Error).message}`);
    return 1;
  } finally {
    await database.close().catch(() => undefined);
  }
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'check') process.exitCode = checkFlows(rest);
else if (command === undefined || command === 'cert' || command === 'user') {
  const config = settings();
  if (config) {
    if (command === 'cert') process.exitCode = await certCommand(config, rest);
    else if (command === 'user') process.exitCode = await users(config, rest);
    else await serve(config);
  }
} else {
  console.error(
    `Unknown command "${command}". Use no command to start the server, or: check <flow files>, cert <command>, user <command>`,
  );
  process.exitCode = 2;
}
