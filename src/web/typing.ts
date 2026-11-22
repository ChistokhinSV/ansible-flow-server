/**
 * Whether a key event is typed into a field. AFS-192: the Files editor (CodeMirror) lives in a
 * shadow root, so the event's target is the host element; the first element of the composed path
 * is the one with the focus.
 */
export function typingInField(e: Event): boolean {
  const first = (e.composedPath?.()[0] ?? e.target) as HTMLElement | null;
  for (const t of [first, e.target as HTMLElement | null]) {
    if (!t || typeof t.tagName !== 'string') continue;
    if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return true;
  }
  return false;
}
