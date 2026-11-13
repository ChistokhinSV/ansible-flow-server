// Light and dark. The page follows the device unless the person chose; the choice is kept in
// this browser. The colours themselves are in styles.css and are the designer's standalone
// theme (ansible-flow-designer, src/webview/theme/standalone.ts), so the canvas and the pages
// around it are one surface.
export type ThemeChoice = 'system' | 'light' | 'dark';
export type ThemeKind = 'light' | 'dark';

const KEY = 'afs.theme';

export function storedTheme(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    // Storage can be blocked (private window, settings): the page works without it.
    return 'system';
  }
}

/** The theme a choice means on this device now. */
export function kindOf(choice: ThemeChoice): ThemeKind {
  if (choice !== 'system') return choice;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Applies a choice to the page and remembers it. */
export function applyTheme(choice: ThemeChoice): ThemeKind {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
  try {
    if (choice === 'system') window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, choice);
  } catch {
    // Not kept: the choice holds until the page is closed.
  }
  return kindOf(choice);
}

/** The next choice when the theme button is pressed: system, light, dark, system. */
export const nextTheme = (choice: ThemeChoice): ThemeChoice =>
  choice === 'system' ? 'light' : choice === 'light' ? 'dark' : 'system';
