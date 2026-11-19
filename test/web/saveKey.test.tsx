// AFS-166: Ctrl+S on a page without a draft: the form being typed in is submitted (its own Save),
// else the page's only form; never a form whose button deletes; never the browser's dialog.
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listenForSaveKey } from '../../src/web/saveKey';

let stop: () => void;
beforeEach(() => {
  stop = listenForSaveKey();
});
afterEach(() => {
  stop();
  cleanup();
});

const ctrlS = (meta = false) => {
  const event = new KeyboardEvent('keydown', {
    key: 's',
    ctrlKey: !meta,
    metaKey: meta,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
};

describe('Ctrl+S on the pages (AFS-166)', () => {
  it('submits the form being typed in, and keeps the browser dialog away', () => {
    const first = vi.fn((e: React.FormEvent) => e.preventDefault());
    const second = vi.fn((e: React.FormEvent) => e.preventDefault());
    const { getByLabelText } = render(
      <main>
        <form onSubmit={first}>
          <input aria-label="Name" />
          <button type="submit">Save</button>
        </form>
        <form onSubmit={second}>
          <input aria-label="Email" />
          <button type="submit">Save</button>
        </form>
      </main>,
    );
    (getByLabelText('Email') as HTMLInputElement).focus();
    expect(ctrlS(true).defaultPrevented).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    // Nothing focused and two forms: nothing is submitted, still no browser dialog.
    (document.activeElement as HTMLElement).blur();
    expect(ctrlS().defaultPrevented).toBe(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("submits the page's only form, but not one that deletes", () => {
    const save = vi.fn((e: React.FormEvent) => e.preventDefault());
    const view = render(
      <main>
        <form onSubmit={save}>
          <input aria-label="Name" />
          <button type="submit">Save</button>
        </form>
      </main>,
    );
    ctrlS();
    expect(save).toHaveBeenCalledTimes(1);
    view.unmount();
    const remove = vi.fn((e: React.FormEvent) => e.preventDefault());
    const { getByLabelText } = render(
      <main>
        <form onSubmit={remove}>
          <input aria-label="Type the name" />
          <button type="submit" className="danger">
            Delete
          </button>
        </form>
      </main>,
    );
    (getByLabelText('Type the name') as HTMLInputElement).focus();
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(remove).not.toHaveBeenCalled();
  });
});
