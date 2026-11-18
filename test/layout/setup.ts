// AFS-138: starts the layout check's server once for every browser, signs the administrator in
// once per theme (a saved browser state each project starts from), and stops the server after.
// The workers read where it is from AFS_LAYOUT_STACK (they inherit this process's environment);
// set it to what `node test/layout/stack.ts` prints to check a server that runs already.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from '@playwright/test';
import { type Stack, startStack } from './stack';

/** Where the signed-in browser states are kept: <theme>.json. */
export const STATES = '.layout-results/state';

export default async function setup() {
  let stop: (() => Promise<void>) | undefined;
  if (!process.env.AFS_LAYOUT_STACK) {
    const { stop: end, ...shown } = await startStack();
    stop = end;
    process.env.AFS_LAYOUT_STACK = JSON.stringify(shown);
  }
  const stack = JSON.parse(process.env.AFS_LAYOUT_STACK) as Omit<Stack, 'stop'>;
  mkdirSync(STATES, { recursive: true });
  for (const theme of ['dark', 'light']) {
    const r = await request.newContext({ baseURL: stack.base });
    const answer = await r.post('/api/v1/session', {
      data: { login: stack.login, password: stack.password },
    });
    if (!answer.ok()) throw new Error(`Sign-in: ${answer.status()} ${await answer.text()}`);
    const state = await r.storageState();
    // The pages are dark unless the person chose light (src/web/theme.ts).
    if (theme === 'light')
      state.origins.push({
        origin: stack.base,
        localStorage: [{ name: 'afs.theme', value: 'light' }],
      });
    writeFileSync(join(STATES, `${theme}.json`), JSON.stringify(state));
    await r.dispose();
  }
  return stop;
}
