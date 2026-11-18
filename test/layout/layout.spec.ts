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
      expect(found, `${path} at ${width}px`).toEqual([]);
    });
