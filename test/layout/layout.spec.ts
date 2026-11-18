// AFS-138: the pages at phone, tablet and desktop widths, in the dark and the light theme (the
// two Playwright projects). On each page: nothing scrolls the page sideways, the breadcrumb stays
// on a line or two, no control is off the side of the window, nothing spills out of the page's
// column, and the flow's canvas has room. The checks come from the exploration rig's layout look
// (AFS-127, test/explore/hub.mjs).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Stack } from './stack';

const stack = JSON.parse(process.env.AFS_LAYOUT_STACK ?? '{}') as Omit<Stack, 'stop'>;
const WIDTHS = [390, 768, 1024, 1440] as const;
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

  return [...new Set(out)];
}

for (const width of WIDTHS)
  for (const [name, path] of Object.entries(stack.pages ?? {}))
    test(`${name} at ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
      await page.goto(stack.base + path);
      await expect(page.locator('main h1').first()).toBeVisible({ timeout: 45_000 });
      // The flow's canvas in the designer's frame: the room its panels leave it.
      const canvas = page.frameLocator('iframe.flow-frame').locator('.afd-center');
      // Attached, not visible: squeezed to no width is what is looked for.
      if (name.startsWith('flow')) await expect(canvas).toBeAttached({ timeout: 45_000 });
      // Lists and chips that come after the first answer.
      await page.waitForTimeout(600);
      if (shots) {
        mkdirSync(shots, { recursive: true });
        await page.screenshot({
          path: join(shots, `${info.project.name}-${width}-${name}.png`),
          fullPage: true,
        });
      }
      const found = await page.evaluate(look);
      if (name.startsWith('flow')) {
        const frame = await page.locator('iframe.flow-frame').boundingBox();
        const room = (await canvas.boundingBox())?.width ?? 0;
        if (frame && room < Math.min(frame.width * 0.6, 600))
          found.push(
            `the canvas is ${Math.round(room)}px wide in a ${Math.round(frame.width)}px frame`,
          );
      }
      expect(found, `${path} at ${width}px`).toEqual([]);
    });
