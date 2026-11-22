// AFS-171: a question asked on the page itself, in place of the browser's confirm(): the pages'
// own look, a modal dialog (the page behind cannot be used, a screen reader reads it as one),
// Escape or Cancel says no, and the focus goes back where it was. One question at a time: a
// second waits for the first to be answered.

export interface AskOptions {
  /**
   * The button that says yes, named by what it does: Delete, Revoke, Take back (AFS-194; every
   * page's question names it, a test checks; "OK" only where nothing better fits).
   */
  yes?: string;
  /** The button that says no (default "Cancel"). */
  no?: string;
  /** Yes loses or changes something for good: the button is red, and Cancel has the focus. */
  danger?: boolean;
}

let queue: Promise<unknown> = Promise.resolve();
let count = 0;

/** Asks `question` on the page; resolves true when the person says yes. */
export function ask(question: string, options: AskOptions = {}): Promise<boolean> {
  const answer = queue.then(() => show(question, options));
  queue = answer.catch(() => undefined);
  return answer;
}

function show(question: string, options: AskOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const before = document.activeElement as HTMLElement | null;
    const id = `confirm-${++count}`;
    const dialog = document.createElement('dialog');
    dialog.className = 'confirm';
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', `${id}-q`);
    const text = document.createElement('p');
    text.id = `${id}-q`;
    text.className = 'confirm-question';
    text.textContent = question;
    const actions = document.createElement('div');
    actions.className = 'actions confirm-actions';
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = options.danger ? 'danger' : 'primary';
    yes.textContent = options.yes ?? 'OK';
    const no = document.createElement('button');
    no.type = 'button';
    no.textContent = options.no ?? 'Cancel';
    actions.append(yes, no);
    dialog.append(text, actions);
    let done = false;
    const finish = (said: boolean) => {
      if (done) return;
      done = true;
      if (dialog.open && typeof dialog.close === 'function') dialog.close();
      dialog.remove();
      if (before?.isConnected) before.focus({ preventScroll: true });
      resolve(said);
    };
    yes.addEventListener('click', () => finish(true));
    no.addEventListener('click', () => finish(false));
    // A modal dialog's Escape is a `cancel`; where there is no modal (an older browser), the key.
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(false);
    });
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
      // Tab stays on the two buttons where the browser does not keep it in the dialog.
      if (event.key === 'Tab') {
        const to = event.target === yes ? no : yes;
        event.preventDefault();
        to.focus();
      }
    });
    // AFS-194: opening the dialog must not move the page (showModal's own focus scrolled it).
    const scrolled = scrolledAround(before);
    document.body.append(dialog);
    if (typeof dialog.showModal === 'function') {
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute('open', '');
      }
    } else dialog.setAttribute('open', '');
    // AFS-186: the page behind stays where it was (on a phone it scrolled to the dialog).
    (options.danger ? no : yes).focus({ preventScroll: true });
    for (const [element, top, left] of scrolled) {
      if (element.scrollTop !== top) element.scrollTop = top;
      if (element.scrollLeft !== left) element.scrollLeft = left;
    }
  });
}

/** The page and the boxes around `element` that scroll, with where they are scrolled to. */
function scrolledAround(element: Element | null): [Element, number, number][] {
  const all: [Element, number, number][] = [];
  const page = document.scrollingElement;
  if (page) all.push([page, page.scrollTop, page.scrollLeft]);
  for (let e = element?.parentElement; e; e = e.parentElement)
    if (e !== page && (e.scrollTop || e.scrollLeft)) all.push([e, e.scrollTop, e.scrollLeft]);
  return all;
}
