// AFS-123: a flow as one commit left it, as the designer's History shows it in VS Code (AFD-320):
// read-only on the canvas, in the Changes lens against the version just before that commit, with
// the commit's author, day and message said by the page around the frame (the flow page), which
// leads back to the flow as it is now (AFS-190: the designer's own banner is off). A flow the commit
// added compares with nothing (every step new).
//   /viewer.html?project=<id>&path=<flow file>&commit=<40 hex>&history=1
import type { FlowDocument } from '@ansible-flow/core/flow/types';
import type { CompareFacts } from '@ansible-flow/core/lens/types';
import type { HostMessage, Snapshot, WebviewMessage } from '@ansible-flow/core/protocol';
import { pastAllows, VIEWER_REFUSAL } from '@ansible-flow/core/viewer';
import { mount, type ThemeChoice } from '@ansible-flow/designer';
import { followPageColours, pageColours } from './palette';
import { answerCatalog } from './viewerCatalog';
import { openWebLink } from './viewerDraft';

/** What the server says a commit did to the flow (GET /flows/commit). */
export interface PastFacts {
  commit: string;
  author: string;
  at: string;
  subject: string;
  change: 'added' | 'changed' | 'removed' | 'unchanged';
  /** The commit to compare with, when it had the flow. */
  before?: string;
}

/** The flow with nothing on it: what a flow the commit added is compared with. */
export function nothingOf(doc: FlowDocument): FlowDocument {
  return { ...doc, nodes: [], edges: [], annotations: [] };
}

/** The Changes lens's one base: the version before the commit, or nothing for a new flow. */
export function compareOf(facts: PastFacts, base: FlowDocument | undefined): CompareFacts {
  // AFS-190: 12 characters, as every page shows a commit.
  const short = facts.commit.slice(0, 12);
  if (!facts.before) {
    const ref = 'nothing';
    const label = `nothing: ${short} added the flow`;
    return base
      ? { state: 'ready', ref, label, refs: [{ ref, label }], base }
      : { state: 'error', ref, label, refs: [], error: 'The flow cannot be read' };
  }
  const ref = facts.before;
  const label = `the version before ${short}`;
  return base
    ? { state: 'ready', ref, label, refs: [{ ref, label }], base }
    : {
        state: 'error',
        ref,
        label,
        refs: [{ ref, label }],
        error: `${label} cannot be read`,
      };
}

/** Shows the flow at the commit in `root`: the designer as a past version, its host this page. */
export function showPast(options: {
  root: HTMLElement;
  project: string;
  path: string;
  theme: ThemeChoice;
  facts: PastFacts;
  snapshot: Snapshot;
  /** The flow at `facts.before`, if it had one and it could be read. */
  before?: FlowDocument;
}): void {
  const { project, path, facts, snapshot } = options;
  const doc = snapshot.doc as FlowDocument | undefined;
  const base = facts.before ? options.before : doc ? nothingOf(doc) : undefined;
  const compare = compareOf(facts, base);
  const listeners = new Set<(message: HostMessage) => void>();
  // The designer expects answers after its own call returns, as from a real host.
  const send = (message: HostMessage) =>
    setTimeout(() => {
      for (const listener of listeners) listener(message);
    }, 0);
  const stateKey = `afs.viewer.${project}.${path}`;
  // Not `viewer: true`: that would keep the designer from turning into a past version. `config`
  // below asks for one, and this host refuses what a past version may not send.
  const designer = mount(options.root, {
    ...pageColours(), // AFS-270, as on the view (viewer.ts)
    theme: options.theme,
    transport: {
      hostName: 'Ansible Flow Server',
      post(message: WebviewMessage) {
        if (!pastAllows(message.type)) {
          if ('reqId' in message && typeof message.reqId === 'number')
            send({ type: 'ack', reqId: message.reqId, ok: false, error: VIEWER_REFUSAL });
          return;
        }
        switch (message.type) {
          case 'ready':
            send({
              type: 'config',
              testMode: false,
              viewer: true,
              past: {
                hash: facts.commit,
                author: facts.author,
                date: facts.at,
                subject: facts.subject,
                path,
              },
              // The page says the commit; nothing here runs. AFS-190: so the canvas does not say
              // it again (`pastShown`, AFD-354: a designer before it ignores it).
              embed: {
                runShown: true,
                mayRun: false,
                mayStop: false,
                words: 'server',
                pastShown: true,
              },
            } as HostMessage);
            send({ type: 'catalogStatus', status: { state: 'idle' } });
            send({ type: 'snapshot', snapshot });
            // A past version opens on what its commit changed.
            send({ type: 'setLens', lens: 'changes' });
            send({ type: 'lensFacts', facts: { compare } });
            return;
          case 'lens':
          case 'compareWith':
            // One base only: the version before the commit.
            send({ type: 'lensFacts', facts: { compare } });
            return;
          case 'catalog':
            answerCatalog(project, path, message, send);
            return;
          case 'openLink':
            openWebLink(message.url);
            return;
          default:
            return;
        }
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getState() {
        try {
          return JSON.parse(window.localStorage.getItem(stateKey) ?? 'null') ?? undefined;
        } catch {
          return undefined;
        }
      },
      setState(state) {
        try {
          window.localStorage.setItem(stateKey, JSON.stringify(state));
        } catch {
          // Not kept: the view starts from the flow's own layout next time.
        }
      },
    },
  });
  followPageColours(designer);
}
