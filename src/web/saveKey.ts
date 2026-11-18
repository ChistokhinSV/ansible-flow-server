// AFS-166: Ctrl+S (Cmd+S) saves, as in an editor, and never opens the browser's "Save page" dialog.
// A page with something of its own to save (a flow's draft) takes the key; on any other page it
// submits the form being typed in, or the page's only form. The designer's frame takes its own
// keys, so it hands this one to the page around it (viewer.ts, SAVE_KEY).
import { useEffect, useRef } from 'react';

/** The message the designer's frame sends when Ctrl+S is pressed in it. */
export const SAVE_KEY = 'afs-save-key';

/** Ctrl+S or Cmd+S, nothing else held. */
export const isSaveKey = (e: KeyboardEvent): boolean =>
  (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's';

let saver: (() => void) | undefined;

/** While a page is shown: Ctrl+S does `save` (the newest page that asks has it). */
export function useSaveKey(save: (() => void) | undefined): void {
  const current = useRef(save);
  current.current = save;
  const on = !!save;
  useEffect(() => {
    if (!on) return;
    const mine = () => current.current?.();
    saver = mine;
    return () => {
      if (saver === mine) saver = undefined;
    };
  }, [on]);
}

/**
 * The form Ctrl+S submits: the one being typed in, else the page's only form. Never one whose
 * button deletes or drops something (a danger button): a key is not a confirmation.
 */
function formToSave(): HTMLFormElement | undefined {
  const typing = document.activeElement;
  const own = typing instanceof HTMLElement ? typing.closest('form') : null;
  const forms = [...document.querySelectorAll<HTMLFormElement>('main form')];
  const form = own ?? (forms.length === 1 ? forms[0] : undefined);
  const button = form?.querySelector('button[type="submit"], button:not([type]), [type="submit"]');
  return form && !button?.classList.contains('danger') ? form : undefined;
}

/** What Ctrl+S does on the page now. */
export function saveNow(): void {
  if (saver) {
    saver();
    return;
  }
  const form = formToSave();
  // requestSubmit checks the form and fires its submit, as a click on its submit button does.
  if (form) form.requestSubmit();
}

/** Listens for Ctrl+S on the page and from the designer's frame; returns how to stop. */
export function listenForSaveKey(): () => void {
  const key = (e: KeyboardEvent) => {
    if (!isSaveKey(e)) return;
    e.preventDefault();
    if (!e.repeat) saveNow();
  };
  const fromFrame = (e: MessageEvent) => {
    if (e.origin !== window.location.origin || e.data?.type !== SAVE_KEY) return;
    saveNow();
  };
  window.addEventListener('keydown', key);
  window.addEventListener('message', fromFrame);
  return () => {
    window.removeEventListener('keydown', key);
    window.removeEventListener('message', fromFrame);
  };
}
