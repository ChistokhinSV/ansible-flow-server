// Dark and light (AFS-64). The pages are dark unless the person chose light or to follow the
// device; the choice is kept in this browser. The colours are in styles.css. The flow canvas is
// told which of the two to use, and takes the page's colours from its canvas roles (palette.ts).
export type ThemeChoice = 'system' | 'light' | 'dark';
export type ThemeKind = 'light' | 'dark';

const KEY = 'afs.theme';

export function storedTheme(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === 'light' || value === 'system' ? value : 'dark';
  } catch {
    // Storage can be blocked (private window, settings): the page works without it.
    return 'dark';
  }
}

/** The theme a choice means on this device now. */
export function kindOf(choice: ThemeChoice): ThemeKind {
  if (choice !== 'system') return choice;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Applies a choice to the page and remembers it. */
export function applyTheme(choice: ThemeChoice): ThemeKind {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
  try {
    if (choice === 'dark') window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, choice);
  } catch {
    // Not kept: the choice holds until the page is closed.
  }
  return kindOf(choice);
}

/** The next choice when the theme button is pressed: dark, light, as the device, dark. */
export const nextTheme = (choice: ThemeChoice): ThemeChoice =>
  choice === 'dark' ? 'light' : choice === 'light' ? 'system' : 'dark';
