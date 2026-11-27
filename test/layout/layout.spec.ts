// AFS-138: the pages at phone, tablet and desktop widths, in the dark and the light theme (the
// two Playwright projects). On each page: nothing scrolls the page sideways, the breadcrumb stays
// on a line or two, no control is off the side of the window, nothing spills out of the page's
// column, and the flow's canvas has room. The checks come from the exploration rig's layout look
// (AFS-127, test/explore/hub.mjs). AFS-154: every page ends at one right edge, and no table cell is
// covered (by a button column that stays in place).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Stack } from './stack';

const stack = JSON.parse(process.env.AFS_LAYOUT_STACK ?? '{}') as Omit<Stack, 'stop'>;
const WIDTHS = [390, 768, 1024, 1440] as const;
/** AFS-148: a laptop's short window too, where the canvas lost its height. */
const SIZES = [...WIDTHS.map((w) => [w, w < 768 ? 844 : 900] as const), [1280, 720] as const];
/** AFS_LAYOUT_SHOTS=<folder> keeps a screenshot of every page looked at. */
const shots = process.env.AFS_LAYOUT_SHOTS;

/** What a person would notice on the page; runs in the page. */
function look() {
  const out: string[] = [];
  const W = window.innerWidth;
  const vis = (e: Element) => {
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const name = (e: Element) =>
    `${e.tagName.toLowerCase()}${e.classList.length ? `.${[...e.classList].slice(0, 2).join('.')}` : ''} "${(e.textContent || e.getAttribute('aria-label') || e.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 40)}"`;
  /** Inside something that scrolls or cuts sideways on purpose (and says so). */
  const contained = (e: Element, upTo: Element | null) => {
    for (let p = e.parentElement; p && p !== upTo; p = p.parentElement) {
      const x = getComputedStyle(p).overflowX;
      if (x === 'auto' || x === 'scroll' || x === 'hidden' || x === 'clip') return p;
    }
    return undefined;
  };

  const sw = document.documentElement.scrollWidth;
  if (sw > W + 1) out.push(`the page scrolls sideways: ${sw}px wide in a ${W}px window`);

  const crumbs = document.querySelector('.bar-crumbs .crumbs');
  // Not `vis`: squeezed to no width is what this looks for.
  if (crumbs && getComputedStyle(crumbs).display !== 'none') {
    const r = crumbs.getBoundingClientRect();
    const line = Number.parseFloat(getComputedStyle(crumbs).lineHeight) || 21;
    if (r.height > line * 2.6 || r.width < 120)
      out.push(`the breadcrumb takes ${Math.round(r.height)}px (${Math.round(r.width)}px wide)`);
  }

  for (const e of document.querySelectorAll(
    'a,button,input,select,textarea,[role=button],[role=tab],summary',
  )) {
    if (!vis(e) || e.classList.contains('skip')) continue;
    const r = e.getBoundingClientRect();
    if (r.right <= W + 1 && r.left >= -1) continue;
    // A box that scrolls sideways (a wide table, with its shade) may hold more than it shows,
    // but a table row's buttons (Launch, Change, Delete, Revoke) must stay in reach.
    const box = contained(e, document.body);
    const action = e.tagName === 'BUTTON' || e.classList.contains('button');
    if (box && !(action && e.closest('table'))) continue;
    out.push(`off the side: ${name(e)} at x=${Math.round(r.left)}..${Math.round(r.right)}`);
  }

  const main = document.querySelector('main');
  if (main) {
    const edge = main.getBoundingClientRect().right;
    const spills = new Set<string>();
    for (const e of main.querySelectorAll('*')) {
      if (spills.size > 5) break;
      if (e.closest('svg') || !vis(e)) continue;
      const r = e.getBoundingClientRect();
      if (r.right > edge + 1 && !contained(e, main)) spills.add(name(e));
    }
    for (const s of spills) out.push(`spills out of the page: ${s}`);
  }

  // AFS-154: one frame. Every page ends where the top bar (its search box) ends, and nothing on it
  // reaches past that edge: a flow, a run's side panel, the files, a box that says not found.
  const bar = document.querySelector('.bar');
  if (main && bar) {
    const inner = (e: Element) =>
      e.getBoundingClientRect().right - (Number.parseFloat(getComputedStyle(e).paddingRight) || 0);
    const frame = inner(bar);
    const page = inner(main);
    if (Math.abs(frame - page) > 1)
      out.push(`the page ends at x=${Math.round(page)}, the top bar at x=${Math.round(frame)}`);
    const past = new Set<string>();
    for (const e of main.querySelectorAll('*')) {
      if (past.size > 5) break;
      if (e.closest('svg') || !vis(e)) continue;
      const r = e.getBoundingClientRect();
      if (r.right > frame + 1 && !contained(e, main))
        past.add(`${name(e)} at x=${Math.round(r.right)}`);
    }
    for (const s of past) out.push(`past the frame's right edge (x=${Math.round(frame)}): ${s}`);
  }

  // AFS-154: no table cell lies under another: a button column that stays in place (sticky)
  // covered the values beside it on a phone.
  const covered = new Set<string>();
  for (const row of document.querySelectorAll('main tr')) {
    const cells = [...row.children].filter(vis);
    for (const held of cells.filter((c) => getComputedStyle(c).position === 'sticky')) {
      const a = held.getBoundingClientRect();
      for (const c of cells) {
        if (c === held) continue;
        const b = c.getBoundingClientRect();
        const wide = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const tall = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (wide > 2 && tall > 2) covered.add(`${name(c)} lies under ${name(held)}`);
      }
    }
  }
  // And what is in sight: a point inside each cell shows that cell, not something over it.
  for (const c of document.querySelectorAll('main td')) {
    if (covered.size > 5 || !vis(c)) continue;
    const r = c.getBoundingClientRect();
    const x = r.left + Math.min(r.width / 2, 12);
    const y = r.top + r.height / 2;
    if (x < 0 || x > W || y < 0 || y > window.innerHeight) continue;
    const box = contained(c, document.body)?.getBoundingClientRect();
    if (box && (x < box.left || x > box.right)) continue;
    const hit = document.elementFromPoint(x, y);
    if (hit && !c.contains(hit) && !hit.contains(c))
      covered.add(`${name(c)} lies under ${name(hit)}`);
  }
  for (const s of covered) out.push(`a table cell is covered: ${s}`);

  // AFS-162: what cannot be undone sits in a box with a border all round, in the theme's red.
  for (const z of document.querySelectorAll('main .danger-zone')) {
    const s = getComputedStyle(z);
    const sides = [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth];
    if (sides.some((w) => Number.parseFloat(w) < 1))
      out.push(`a danger zone without its border: ${name(z)}`);
    const h = z.querySelector('h2');
    if (h && getComputedStyle(h).color !== s.borderTopColor)
      out.push(`a danger zone's title is not in its border's red: ${name(z)}`);
  }

  return [...new Set(out)];
}

for (const [width, height] of SIZES)
  for (const [name, path] of Object.entries(stack.pages ?? {}))
    test(`${name} at ${width}px${height === 720 ? ` x ${height}` : ''}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height });
      await page.goto(stack.base + path);
      await expect(page.locator('main h1').first()).toBeVisible({ timeout: 45_000 });
      // AFS-165: the draft open (the frame is the draft's from then on).
      if (name === 'flowEdit')
        await expect(page.getByRole('button', { name: 'Stop editing' })).toBeVisible({
          timeout: 45_000,
        });
      // The flow's canvas in the designer's frame: the room its panels leave it.
      const canvas = page.frameLocator('iframe.flow-frame').locator('.afd-center');
      // Attached, not visible: squeezed to no width is what is looked for.
      if (name.startsWith('flow')) await expect(canvas).toBeAttached({ timeout: 45_000 });
      // Lists and chips that come after the first answer.
      await page.waitForTimeout(600);
      if (shots) {
        mkdirSync(shots, { recursive: true });
        await page.screenshot({
          path: join(shots, `${info.project.name}-${width}x${height}-${name}.png`),
          fullPage: true,
        });
      }
      const found = await page.evaluate(look);
      if (name.startsWith('flow')) {
        const frame = await page.locator('iframe.flow-frame').boundingBox();
        const box = await canvas.boundingBox();
        const room = box?.width ?? 0;
        if (frame && room < Math.min(frame.width * 0.6, 600))
          found.push(
            `the canvas is ${Math.round(room)}px wide in a ${Math.round(frame.width)}px frame`,
          );
        // AFS-148: the side panel beside the canvas or folded, not under it (170 to 300px left).
        const tall = box?.height ?? 0;
        if (frame && tall < frame.height * 0.7)
          found.push(
            `the canvas is ${Math.round(tall)}px tall in a ${Math.round(frame.height)}px frame`,
          );
      }
      // AFS-195: a flow's page fits the window from tablet width up: it does not scroll a few
      // pixels because the breadcrumb took a third line.
      if ((name === 'flow' || name === 'flowDeep') && width >= 768) {
        const over = await page.evaluate(
          () => document.documentElement.scrollHeight - window.innerHeight,
        );
        if (over > 1) found.push(`the flow's page scrolls ${over}px down`);
      }
      // AFS-165: editing, the canvas is right under the head: no lines of text between. AFS-186:
      // who is here is a line in the head, so someone coming or going never moves the canvas.
      if (name === 'flowEdit') {
        const head = await page.locator('main .page-head').first().boundingBox();
        const together = await page.getByRole('region', { name: 'Editing together' }).boundingBox();
        const frame = await page.locator('iframe.flow-frame').boundingBox();
        const gap = head && frame ? frame.y - (head.y + head.height) : 0;
        if (gap > 32)
          found.push(`editing, the canvas starts ${Math.round(gap)}px under what is over it`);
        if (
          !together ||
          !head ||
          together.y < head.y - 1 ||
          together.y + together.height > head.y + head.height + 1
        )
          found.push('editing, the line of who is here is not in the head');
      }
      // AFS-199: the API reference fills its frame, and nothing in the frame scrolls sideways.
      if (name === 'apiDocs') {
        const frame = page.frameLocator('iframe.api-frame');
        await expect(frame.getByRole('heading', { name: 'Ansible Flow Server API' })).toBeVisible({
          timeout: 45_000,
        });
        const box = await page.locator('iframe.api-frame').boundingBox();
        if (!box || box.height < 300)
          found.push(`the API reference's frame is ${Math.round(box?.height ?? 0)}px tall`);
        const inside = await frame
          .locator('html')
          .evaluate((e) => [e.scrollWidth, e.clientWidth] as const);
        if (inside[0] > inside[1] + 1)
          found.push(`the API reference scrolls sideways: ${inside[0]}px in ${inside[1]}px`);
      }
      // AFS-169 (AFS-161): an environment's Save and Build stay in sight while its spec is on the
      // screen, however long the spec.
      if (name === 'environment') {
        const bar = await page.evaluate(() => {
          const actions = document.querySelector('.env-spec .form > .actions');
          const form = actions?.parentElement;
          if (!actions || !form) return 'no Save and Build bar';
          const a = actions.getBoundingClientRect();
          if (
            form.getBoundingClientRect().top < window.innerHeight &&
            a.bottom > window.innerHeight + 1
          )
            return `Save and Build are below the window (bottom at ${Math.round(a.bottom)}px in ${window.innerHeight}px)`;
          return getComputedStyle(actions).position === 'sticky'
            ? ''
            : 'Save and Build do not stay';
        });
        if (bar) found.push(bar);
      }
      // AFS-250, AFS-265: a debug run's reason (the status line) and toolbar are in sight without
      // scrolling. On a phone the workbench is tabs (Flow · Debug · Console); from tablet width up
      // the side bar is left of the canvas and the only tabs are the bottom panel's.
      if (name === 'debugRun') {
        const reason = await page.locator('[data-debug-reason]').boundingBox();
        const stop = await page.locator('[data-debugger] [data-step-command="stop"]').boundingBox();
        if (!reason || !stop || stop.y + stop.height > height)
          found.push(
            `the debug toolbar or status line is not in the window: ${JSON.stringify(stop)}`,
          );
        const tabs = await page.getByRole('tablist').count();
        const panelTabs = await page.locator('.wb-panel [role="tablist"]').count();
        if (width <= 860 && tabs < 1) found.push('no Flow · Debug · Console tabs');
        if (width > 860 && tabs !== panelTabs)
          found.push(`tabs other than the panel's at ${width}px`);
        if (width > 860) {
          const frame = await page.locator('iframe.flow-frame').boundingBox();
          const side = await page.locator('.wb-side').boundingBox();
          if (!frame || (side && side.x > frame.x))
            found.push('the side bar is not left of the canvas');
        }
      }
      expect(found, `${path} at ${width}px`).toEqual([]);
    });

// AFS-169: the first change to a file brings Changes not saved without moving the editor.
test('files: a change does not move the editor', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${stack.base}${stack.pages?.files}`);
  const editor = page.locator('section.code-editor');
  await expect(editor).toBeVisible({ timeout: 45_000 });
  const before = await editor.boundingBox();
  await page.locator('section.code-editor .cm-content').click();
  await page.keyboard.type('x');
  await expect(page.getByRole('heading', { name: /Changes not saved/ })).toBeVisible();
  const after = await editor.boundingBox();
  expect(Math.round(after?.y ?? 0)).toBe(Math.round(before?.y ?? -1));
});
// AFS-171: a question asked on the page (here: leaving a form with typing in it) fits the window,
// in both themes, and Escape says no.
for (const [width, height] of SIZES)
  test(`a question asked on the page at ${width}px${height === 720 ? ` x ${height}` : ''}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height });
    await page.goto(`${stack.base}/workspaces`);
    await page.locator('main a[href="/w/network"]').first().click({ timeout: 45_000 });
    await page.getByRole('button', { name: 'Add project' }).click();
    await page.getByLabel('Name').fill('Edge switches');
    await page.goBack();
    const dialog = page.getByRole('dialog', {
      name: 'Leave this page? What you typed is not saved.',
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Stay' })).toBeFocused();
    if (shots) {
      mkdirSync(shots, { recursive: true });
      await page.screenshot({
        path: join(shots, `${info.project.name}-${width}x${height}-question.png`),
      });
    }
    const found = await page.evaluate(look);
    const box = await dialog.boundingBox();
    if (!box || box.x < 0 || box.y < 0 || box.x + box.width > width || box.y + box.height > height)
      found.push(`the question is not all in the window: ${JSON.stringify(box)}`);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect(page.url()).toBe(`${stack.base}/w/network`);
    expect(found, `the question at ${width}px`).toEqual([]);
  });

// AFS-274: the menu folded to its icon rail (its three groups and the account), and the menus its
// buttons open (the workspace switcher, the account): nothing off the window or past the frame,
// and the open menu inside the window.
for (const width of [1024, 1440] as const)
  test(`the menu folded at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem('afs.menu.folded', '1');
      } catch {
        // A window without storage shows the menu unfolded: then this checks that.
      }
    });
    await page.goto(stack.base + (stack.pages?.runs ?? '/runs'));
    await expect(page.locator('main h1').first()).toBeVisible({ timeout: 45_000 });
    await expect(page.locator('.side.rail')).toBeVisible();
    await page.waitForTimeout(600);
    expect(await page.evaluate(look), `folded at ${width}px`).toEqual([]);
  });

for (const [width, height] of [
  [390, 844],
  [1280, 720],
] as const)
  for (const menu of ['Workspace', 'Account'])
    test(`the ${menu.toLowerCase()} menu open at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto(stack.base + (stack.pages?.home ?? '/'));
      await expect(page.locator('main h1').first()).toBeVisible({ timeout: 45_000 });
      if (width <= 860) await page.getByRole('button', { name: 'Menu' }).click();
      await page.getByRole('button', { name: new RegExp(`^${menu}: `) }).click();
      const list = page.getByRole('menu');
      await expect(list).toBeVisible();
      const box = await list.boundingBox();
      const found = await page.evaluate(look);
      if (
        !box ||
        box.x < 0 ||
        box.y < 0 ||
        box.x + box.width > width + 1 ||
        box.y + box.height > height + 1
      )
        found.push(`the ${menu} menu is not inside the window: ${JSON.stringify(box)}`);
      expect(found, `${menu} menu at ${width}px`).toEqual([]);
    });

// AFS-277: a flow's page names the flow once: its title. Not again as the breadcrumb's last part,
// nor on the canvas's own top bar in the frame, which keeps the flow's key and version. A canvas
// opened on a page of its own has nothing else naming the flow, and keeps the name.
test('a flow is named once on its page, and on a page of its own by the canvas', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(stack.base + (stack.pages?.flow ?? '/'));
  const title = page.locator('main h1');
  const canvas = page.frameLocator('iframe.flow-frame');
  await expect(canvas.locator('.afd-topbar')).toBeVisible({ timeout: 45_000 });
  // The title is the file's name until the flow is read.
  await expect(title).not.toHaveText(/\.ya?ml$/);
  const name = (await title.textContent()) ?? '';
  expect(name).not.toBe('');
  await expect(page.locator('.bar .crumbs')).not.toContainText(name);
  await expect(canvas.locator('.afd-topbar .afd-chip.mono')).toBeVisible();
  await expect(canvas.locator('.afd-topbar .afd-flow-name')).toBeHidden();
  const own = await page.getByRole('link', { name: 'Open on its own page' }).getAttribute('href');
  await page.goto(stack.base + own);
  await expect(page.locator('.afd-topbar .afd-flow-name')).toHaveText(name, { timeout: 45_000 });
});
