// AFS-270 (ADR-0039 §6): the flow's canvas in the page's colours. Outside VS Code the designer
// wears its standalone theme, VS Code's default colours, which looked like another application
// inside the pages. The frame reads the page's canvas roles (`--canvas-*`, styles.css) from the
// page around it, on the same origin, and gives them to the designer: designer 1.2.0-rc.6 and
// later take them, an older one ignores them. A viewer opened as a page of its own has no page
// around it, so it keeps the designer's colours.
/** A designer palette: values of the `--vscode-*` variables the canvas reads. */
export type Palette = Readonly<Record<string, string>>;

/** Which of the page's canvas roles each of the canvas's variables takes. */
export const CANVAS_ROLES: Readonly<Record<string, string>> = {
  '--vscode-editor-background': '--canvas-ground',
  '--vscode-editor-foreground': '--canvas-text',
  '--vscode-foreground': '--canvas-text',
  '--vscode-descriptionForeground': '--canvas-muted',
  '--vscode-input-placeholderForeground': '--canvas-faint',
  '--vscode-editorLineNumber-foreground': '--canvas-grid',
  '--vscode-sideBar-background': '--canvas-panel',
  '--vscode-editorWidget-background': '--canvas-panel',
  '--vscode-editorWidget-foreground': '--canvas-text',
  '--vscode-editorHoverWidget-background': '--canvas-panel',
  '--vscode-editorHoverWidget-foreground': '--canvas-text',
  '--vscode-editorSuggestWidget-background': '--canvas-panel',
  '--vscode-menu-background': '--canvas-panel',
  '--vscode-menu-foreground': '--canvas-text',
  '--vscode-menu-selectionBackground': '--canvas-raised',
  '--vscode-menu-selectionForeground': '--canvas-text',
  '--vscode-notifications-background': '--canvas-panel',
  '--vscode-notifications-foreground': '--canvas-text',
  '--vscode-editorWidget-border': '--canvas-line',
  '--vscode-editorHoverWidget-border': '--canvas-line',
  '--vscode-editorSuggestWidget-border': '--canvas-line',
  '--vscode-widget-border': '--canvas-line',
  '--vscode-panel-border': '--canvas-line',
  '--vscode-menu-border': '--canvas-line',
  '--vscode-menu-separatorBackground': '--canvas-line',
  '--vscode-notifications-border': '--canvas-line',
  '--vscode-list-hoverBackground': '--canvas-hover',
  '--vscode-toolbar-hoverBackground': '--canvas-hover',
  '--vscode-list-activeSelectionBackground': '--canvas-raised',
  '--vscode-list-activeSelectionForeground': '--canvas-text',
  '--vscode-focusBorder': '--canvas-accent',
  '--vscode-button-background': '--canvas-accent',
  '--vscode-button-foreground': '--canvas-accent-fg',
  '--vscode-button-secondaryBackground': '--canvas-button',
  '--vscode-button-secondaryForeground': '--canvas-text',
  '--vscode-button-secondaryHoverBackground': '--canvas-hover',
  '--vscode-input-background': '--canvas-input',
  '--vscode-input-foreground': '--canvas-text',
  '--vscode-input-border': '--canvas-input-line',
  '--vscode-textLink-foreground': '--canvas-link',
  '--vscode-textCodeBlock-background': '--canvas-code',
  '--vscode-errorForeground': '--canvas-error',
  '--vscode-editorError-foreground': '--canvas-error',
  '--vscode-editorWarning-foreground': '--canvas-warning',
};

/** The palette a page's canvas roles make; none when the page sets none of them. */
export function paletteOf(
  style: Pick<CSSStyleDeclaration, 'getPropertyValue'>,
): Palette | undefined {
  const palette: Record<string, string> = {};
  for (const [name, role] of Object.entries(CANVAS_ROLES)) {
    const value = style.getPropertyValue(role).trim();
    if (value) palette[name] = value;
  }
  return Object.keys(palette).length ? palette : undefined;
}

/** The colours of the page around this frame, as it shows now; none for a page of its own. */
export function pagePalette(win: Window = window): Palette | undefined {
  try {
    if (win.parent === win) return undefined;
    return paletteOf(win.getComputedStyle(win.parent.document.documentElement));
  } catch {
    // A page of another origin around the frame (never the server's own): the designer's colours.
    return undefined;
  }
}

/**
 * The page's colours as a mount option, spread into the designer's options. A designer without
 * `palette` (1.2.0-rc.5) ignores it; a spread is not checked against the options it knows.
 */
export function pageColours(win: Window = window): { palette?: Palette } {
  const palette = pagePalette(win);
  return palette ? { palette } : {};
}

/**
 * A page that follows the device changes its colours when the device turns light or dark, and the
 * designer follows the device too: the canvas takes the page's new colours. A designer without
 * `setPalette` (1.2.0-rc.5) has nothing to take them with.
 */
export function followPageColours(mounted: unknown, win: Window = window): void {
  const designer = mounted as { setPalette?: (palette: Palette | undefined) => void } | undefined;
  if (typeof designer?.setPalette !== 'function') return;
  win
    .matchMedia?.('(prefers-color-scheme: dark)')
    ?.addEventListener('change', () => designer.setPalette?.(pagePalette(win)));
}
