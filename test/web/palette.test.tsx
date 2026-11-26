// The canvas in the page's colours (AFS-270): the flow's frame reads the page's canvas roles and
// gives them to the designer, which takes plain colours on `--vscode-*` names and nothing else.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  CANVAS_ROLES,
  followPageColours,
  pageColours,
  pagePalette,
  paletteOf,
} from '../../src/web/palette';

const STYLES = readFileSync('src/web/styles.css', 'utf8');
// The designer's test for a value it takes (AFD-383, theme/standalone.ts).
const COLOUR =
  /^(?:#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(?:rgba?|hsla?)\([0-9.,%\s/+-]+\)|transparent)$/;

const styleOf = (values: Record<string, string>) => ({
  getPropertyValue: (name: string) => values[name] ?? '',
});

/** A frame's window inside a page whose canvas roles are `roles`. */
function framed(roles: Record<string, string>) {
  const listeners: (() => void)[] = [];
  const frames: (() => void)[] = [];
  // The page's window computes the page's styles; the frame's own knows nothing of its roles.
  const page = { document: { documentElement: {} }, getComputedStyle: () => styleOf(roles) };
  const win = {
    parent: page,
    getComputedStyle: () => styleOf({}),
    matchMedia: vi.fn(() => ({
      addEventListener: (_kind: string, listener: () => void) => listeners.push(listener),
    })),
    requestAnimationFrame: (f: () => void) => frames.push(f),
  };
  return {
    win: win as unknown as Window,
    matchMedia: win.matchMedia,
    deviceTurns: () => {
      for (const l of listeners) l();
    },
    nextFrame: () => {
      for (const f of frames.splice(0)) f();
    },
  };
}

describe('the page’s colours for the canvas', () => {
  it('gives each canvas variable its role’s colour, trimmed, and leaves out roles not set', () => {
    const palette = paletteOf(
      styleOf({ '--canvas-ground': ' #12171e', '--canvas-text': '#e8ecf1' }),
    );
    expect(palette?.['--vscode-editor-background']).toBe('#12171e');
    expect(palette?.['--vscode-editor-foreground']).toBe('#e8ecf1');
    expect(palette?.['--vscode-foreground']).toBe('#e8ecf1');
    expect(palette).not.toHaveProperty('--vscode-button-background');
    expect(paletteOf(styleOf({}))).toBeUndefined();
  });

  it('reads the page around the frame, and nothing when the viewer is a page of its own', () => {
    expect(pagePalette(framed({ '--canvas-accent': '#3ccfb8' }).win)).toEqual({
      '--vscode-focusBorder': '#3ccfb8',
      '--vscode-button-background': '#3ccfb8',
    });
    // jsdom's window is its own parent, as a viewer opened on its own.
    expect(pagePalette(window)).toBeUndefined();
    expect(pageColours(window)).toEqual({});
  });

  it('keeps the designer’s colours when the page around cannot be read', () => {
    const win = {
      get parent(): never {
        throw new DOMException('Blocked a frame', 'SecurityError');
      },
    } as unknown as Window;
    expect(pagePalette(win)).toBeUndefined();
  });

  it('every role the canvas takes is set by the page as a plain colour, in every theme', () => {
    const roles = new Set(Object.values(CANVAS_ROLES));
    for (const role of roles) {
      const set = STYLES.match(new RegExp(`^\\s*${role}:\\s*var\\((--[a-z0-9-]+)\\);`, 'm'));
      expect(set, `${role} is not set in styles.css`).not.toBeNull();
      const raw = set?.[1] as string;
      // The dark theme, the light theme, and the light theme of a page that follows the device.
      const values = [...STYLES.matchAll(new RegExp(`^\\s*${raw}:\\s*([^;]+);`, 'gm'))].map((m) =>
        (m[1] as string).trim(),
      );
      expect(values.length, `${raw} is set in each theme`).toBeGreaterThanOrEqual(3);
      for (const value of values) expect(value, `${role} → ${raw}`).toMatch(COLOUR);
    }
  });
});

describe('following the page when the device turns light or dark', () => {
  it('gives the designer the page’s new colours', () => {
    const roles: Record<string, string> = { '--canvas-ground': '#12171e' };
    const frame = framed(roles);
    const setPalette = vi.fn();
    followPageColours({ setPalette }, frame.win);
    frame.deviceTurns();
    // The page's own media query re-applies its colours after the frame hears of the change: they
    // are read a frame later.
    expect(setPalette).not.toHaveBeenCalled();
    roles['--canvas-ground'] = '#f6f7f9';
    frame.nextFrame();
    expect(setPalette).toHaveBeenCalledWith(
      expect.objectContaining({ '--vscode-editor-background': '#f6f7f9' }),
    );
  });

  it('does nothing with a designer that cannot take colours (1.2.0-rc.5)', () => {
    const frame = framed({ '--canvas-ground': '#12171e' });
    followPageColours(undefined, frame.win);
    followPageColours({}, frame.win);
    expect(frame.matchMedia).not.toHaveBeenCalled();
  });
});
