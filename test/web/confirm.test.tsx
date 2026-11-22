// AFS-171: the question the pages ask on the page itself (in place of the browser's confirm()):
// a modal dialog with the question as its name, yes and Cancel, Escape for no, one question at a
// time, the focus back where it was. The other pages' tests answer through window.confirm
// (setup.ts); this one uses the dialog itself.
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

let ask: typeof import('../../src/web/confirm').ask;
beforeAll(async () => {
  ({ ask } =
    await vi.importActual<typeof import('../../src/web/confirm')>('../../src/web/confirm'));
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('ask', () => {
  it('asks in a dialog named by its question; yes says true, and the dialog goes', async () => {
    const before = document.createElement('button');
    before.textContent = 'Delete';
    document.body.append(before);
    before.focus();
    const answer = ask('Delete the schedule "nightly"?', { yes: 'Delete', danger: true });
    const dialog = await screen.findByRole('dialog', { name: 'Delete the schedule "nightly"?' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // Saying yes loses something: the red button, and Cancel has the focus.
    const yes = screen.getAllByRole('button', { name: 'Delete' }).find((b) => dialog.contains(b));
    expect(yes?.className).toBe('danger');
    expect(document.activeElement?.textContent).toBe('Cancel');
    fireEvent.click(yes as HTMLElement);
    expect(await answer).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(before);
  });

  it('Cancel and Escape say no; OK is the yes of a plain question and has the focus', async () => {
    const first = ask('Go back to this certificate?');
    await screen.findByRole('dialog');
    expect(document.activeElement?.textContent).toBe('OK');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await first).toBe(false);
    const second = ask('Launch the check run?');
    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(await second).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('one question at a time: the second waits for the first', async () => {
    const one = ask('First?');
    const two = ask('Second?');
    await screen.findByRole('dialog', { name: 'First?' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(await one).toBe(true);
    await screen.findByRole('dialog', { name: 'Second?' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await two).toBe(false);
  });
});

// AFS-194: every question a page asks names its yes by what it does (Delete, Revoke, Take back),
// never a bare "OK": each ask( call from a page passes `yes:`.
describe('the pages’ questions', () => {
  it('each names its yes button', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(__dirname, '../../src/web');
    const unnamed: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!/\.tsx?$/.test(file) || file === 'confirm.ts') continue;
      const text = readFileSync(join(dir, file), 'utf8');
      if (!/import \{[^}]*\bask\b[^}]*\} from '\.\/confirm'/.test(text)) continue;
      for (const m of text.matchAll(/\bask\(/g)) {
        // The call's text, to its closing bracket.
        let depth = 0;
        let end = m.index + 3;
        for (; end < text.length; end++) {
          if (text[end] === '(') depth++;
          else if (text[end] === ')' && --depth === 0) break;
        }
        const call = text.slice(m.index, end + 1);
        if (!/\byes:/.test(call)) unnamed.push(`${file}: ${call.slice(0, 80)}`);
      }
    }
    expect(unnamed).toEqual([]);
  });
});
