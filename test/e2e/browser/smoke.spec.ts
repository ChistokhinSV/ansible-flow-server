// Browser smoke test (AFS-38): the pages in a real browser against the compose stack and the lab.
// Olga signs in, opens a flow on the canvas, launches it; Andre approves it from his approvals;
// the run goes well and is in the history. Run with `just e2e-browser` (test/e2e/README.md).
import { expect, test } from '@playwright/test';
import { base, existingWorld, freshWorld, type World } from '../lib/world';

let world: World;
test.beforeAll(async () => {
  test.setTimeout(900_000);
  world = (await existingWorld()) ?? (await freshWorld());
});

async function signIn(page: import('@playwright/test').Page, login: 'olga' | 'andre') {
  await page.goto(`${base}/`);
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill(world.passwords[login] ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

test('sign in, view a flow, launch it, approve it, see it in the history', async ({ browser }) => {
  test.setTimeout(600_000);
  const olgaContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await olgaContext.newPage();
  await signIn(page, 'olga');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Olga');

  // The flow on the designer's canvas, read-only.
  await page.goto(`${base}/w/lab/infra/flow/flows/lab-approval.flow.yaml`);
  const canvas = page.frameLocator('iframe.flow-frame');
  await expect(canvas.getByText('Approve the change').first()).toBeVisible({ timeout: 30_000 });

  // Launch from the launch configuration; the run's page opens and waits for the change board.
  await page.goto(`${base}/w/lab/infra/launch/${world.configs.approval}`);
  await page.getByRole('button', { name: 'Launch', exact: true }).click();
  await page.waitForURL(/\/runs\/[0-9a-f-]+$/);
  const runUrl = page.url();
  await expect(page.getByText('waiting for a decision').first()).toBeVisible({ timeout: 300_000 });

  // Andre decides from his approvals.
  const andreContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const andre = await andreContext.newPage();
  await signIn(andre, 'andre');
  await andre.goto(`${base}/approvals`);
  const mine = andre.locator('li.decision').filter({ hasText: 'Approve the change' }).first();
  await mine.getByLabel('Comment').fill('Checked in the browser');
  await mine.getByRole('button', { name: 'Approve' }).click();
  await expect(mine).toBeHidden({ timeout: 30_000 });

  // Olga's page follows the run to its end, and the history has it.
  await page.goto(runUrl);
  await expect(page.getByText('went well').first()).toBeVisible({ timeout: 300_000 });
  await page.goto(`${base}/runs`);
  const row = page.locator(`a[href="${new URL(runUrl).pathname}"]`);
  await expect(row).toContainText('Lab: change after approval');
  await expect(row).toContainText('went well');

  await andreContext.close();
  await olgaContext.close();
});
