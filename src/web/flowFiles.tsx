// AFS-109: a flow made, copied or deleted in the pages, each as one commit on the project's branch
// (the files save of AFS-78). A new flow is the designer's own template (Start wired to Done, a host
// list input); a copy gets a new id and key in its header; deleting says which launch
// configurations use the flow first.
import { createIdFactory, SLUG } from '@ansible-flow/core/flow/ids';
import { newFlowText } from '@ansible-flow/core/flow/template';
import { useEffect, useRef, useState } from 'react';
import { api, type Project } from './api';
import { navigate } from './router';
import { Field, Form, Icon, messageOf, refuse, useLoad } from './ui';

const flowPage = (workspace: string, project: string, file: string) =>
  `/w/${encodeURIComponent(workspace)}/${encodeURIComponent(project)}/flow/${file
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;

/** Letters that do not come apart into a plain letter and marks. */
const SPELLED: Record<string, string> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ı: 'i',
};

/**
 * A key from a name: lower case words joined by dashes. AFS-140: accented letters are kept as
 * their plain letter (Ünïcödé: unicode), and a long name is cut between words, not inside one.
 */
export const keyOf = (name: string, max = 60) => {
  const words = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[ßæœøłđðþı]/g, (c) => SPELLED[c] ?? c)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (words.length <= max) return words;
  const cut = words.slice(0, max + 1).lastIndexOf('-');
  return (cut > 0 ? words.slice(0, cut) : words.slice(0, max)).replace(/-+$/, '');
};

/**
 * AFS-125: the key as the name changes: it follows the name (keyOf) while it is empty or still the
 * key of the name before, and stays once someone typed a key of their own.
 */
export const followKey = (name: string, before: string, key: string, max = 60) =>
  key === '' || key === keyOf(before, max) ? keyOf(name, max) : key;

/**
 * The flow's text with a new header: its own id, key, name, and version 1. Only the `flow:` block
 * changes; the nodes keep their ids (they are a flow's own).
 */
export function copiedFlowText(text: string, name: string, key: string, id: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^flow:\s*$/.test(l));
  if (start < 0) throw new Error('This file has no flow header');
  let end = start + 1;
  while (end < lines.length && (/^\s/.test(lines[end] ?? '') || (lines[end] ?? '') === '')) end++;
  const set = (field: string, value: string) => {
    for (let i = start + 1; i < end; i++)
      if (new RegExp(`^  ${field}:`).test(lines[i] ?? '')) {
        lines[i] = `  ${field}: ${value}`;
        return;
      }
  };
  set('id', id);
  set('key', key);
  set('name', JSON.stringify(name));
  set('version', '1');
  return lines.join('\n');
}

/** AFS-140: what is wrong with a new flow's file, in words, or undefined. */
export function fileProblem(path: string, taken?: ReadonlySet<string>): string | undefined {
  if (path.startsWith('/') || path.split('/').some((p) => p === '..' || p === '.' || p === ''))
    return 'The file must be inside the project, such as flows/patch-web/patch-web.flow.yaml (no ../).';
  if (!/\.flow\.yaml$/.test(path)) return 'A flow file ends in .flow.yaml.';
  if (taken?.has(path)) return `There is a file ${path} already: choose another name.`;
  return undefined;
}

/** AFS-140: `file`, or the first of file-2, file-3... that is not taken. */
export function freeFile(file: string, taken: ReadonlySet<string>): string {
  if (!file || !taken.has(file)) return file;
  const stem = file.replace(/\.flow\.yaml$/, '');
  for (let n = 2; ; n++) if (!taken.has(`${stem}-${n}.flow.yaml`)) return `${stem}-${n}.flow.yaml`;
}

/** AFS-140: the files of the project's branch, to say a name is taken before saving. */
function useTaken(project: Project, when = true): ReadonlySet<string> {
  const files = useLoad(
    async () =>
      when && project.commit
        ? new Set((await api.files(project.id, project.gitRef)).files.map((f) => f.path))
        : new Set<string>(),
    [project.id, project.commit, when],
  );
  return files.data ?? NONE;
}
const NONE: ReadonlySet<string> = new Set();

/**
 * AFS-144: where a new flow's file goes, as the samples lay theirs out: a folder of its own under
 * flows/ (its scenarios file goes beside it). A copy of a flow kept that way gets a folder too; a
 * copy of one kept otherwise stays beside it.
 */
export function flowFileFor(key: string, from?: string): string {
  if (!from) return `flows/${key}/${key}.flow.yaml`;
  const own = /^(.*\/)?([^/]+)\/\2\.flow\.yaml$/.exec(from);
  if (own) return `${own[1] ?? ''}${key}/${key}.flow.yaml`;
  const folder = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
  return `${folder}${key}.flow.yaml`;
}

/** New flow, on a project's page. */
export function NewFlowForm({
  workspace,
  project,
  onCancel,
}: {
  workspace: string;
  project: Project;
  onCancel(): void;
}) {
  const [name, setName] = useState('');
  const [path, setPath] = useState<string>();
  const key = keyOf(name);
  const taken = useTaken(project);
  const file = path ?? (key ? freeFile(flowFileFor(key), taken) : '');
  return (
    <section className="panel sheet" aria-label="New flow">
      <Form
        open
        submit="Make the flow"
        onCancel={onCancel}
        onSubmit={async () => {
          if (!SLUG.test(key)) refuse('name', 'A name with letters or digits is needed.');
          const problem = fileProblem(file, taken);
          if (problem) refuse('file', problem);
          await api.saveFiles(project.id, {
            branch: project.gitRef,
            message: `Add the flow ${name.trim()}`,
            changes: [
              { op: 'write', path: file, text: newFlowText(name.trim(), key, createIdFactory()) },
            ],
          });
          // AFS-113: a new flow opens for editing.
          navigate(`${flowPage(workspace, project.key, file)}?edit=1`);
        }}
      >
        <Field
          label="Name"
          name="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={120}
          placeholder="Patch web servers"
        />
        <Field
          label="File"
          name="file"
          value={file}
          onChange={(e) => setPath(e.target.value)}
          required
          spellCheck={false}
          hint={`Made from the name: a folder of its own under flows/, as the samples have. One commit on ${project.gitRef}${project.commit ? '' : ', the first of the project'}. It starts with Start wired to Done and a host list input, and opens for editing.`}
        />
      </Form>
    </section>
  );
}

/** Copy and Delete, on a flow's page. */
export function FlowFileActions({
  workspace,
  project,
  file,
  name,
  commit,
  usedBy,
  configIds = [],
  doing,
  onDone,
}: {
  workspace: string;
  project: Project;
  file: string;
  name: string;
  commit: string;
  /** Names of the launch configurations that run it. */
  usedBy: string[];
  /** AFS-147: their ids, to name the schedules that would fire it. */
  configIds?: string[];
  /** AFS-110: which form is open (picked in the head's More menu), and closing it. */
  doing?: 'copy' | 'delete';
  onDone(): void;
}) {
  const [copyName, setCopyName] = useState(`${name} (copy)`);
  // The name as the page knows it when Copy is picked (a new flow's name comes after its file).
  // biome-ignore lint/correctness/useExhaustiveDependencies: set when the copy form opens
  useEffect(() => {
    if (doing === 'copy') {
      setCopyName(`${name} (copy)`);
      setCopyPath(undefined);
    }
  }, [doing]);
  const copyKey = keyOf(copyName);
  const [copyPath, setCopyPath] = useState<string>();
  const taken = useTaken(project, doing === 'copy');
  // AFS-140: the file offered is one that is not there yet; AFS-144: in a folder of its own.
  const copyFile = copyPath ?? (copyKey ? freeFile(flowFileFor(copyKey, file), taken) : '');
  const [error, setError] = useState<string>();
  // AFS-134: one delete at a time (a double click sent two).
  const [deleting, setDeleting] = useState(false);
  // AFS-147: the schedules that would fire it after it is gone, named before the delete. AFS-150:
  // those of configurations that follow the branch it is deleted on (not pinned to a commit or on
  // another branch, where it stays) are turned off with it, so they do not fire and fail.
  const schedules = useLoad(
    async () =>
      doing === 'delete' && configIds.length
        ? (
            await Promise.all(
              configIds.map(async (id) => {
                const [config, list] = await Promise.all([
                  api.launchConfig(id).catch(() => undefined),
                  api.schedules(id).catch(() => []),
                ]);
                const follows =
                  !!config &&
                  !config.commit &&
                  (!config.gitRef || config.gitRef === project.gitRef);
                return follows ? list : [];
              }),
            )
          ).flat()
        : [],
    [doing, configIds.join(' ')],
  ).data?.filter((s) => s.enabled);
  return (
    <>
      {doing === 'copy' && (
        <section className="panel sheet" aria-label="Copy the flow">
          <Form
            open
            submit="Make the copy"
            onCancel={() => onDone()}
            onSubmit={async () => {
              if (!SLUG.test(copyKey)) refuse('name', 'A name with letters or digits is needed.');
              if (copyFile === file) refuse('file', 'Another file than the flow itself.');
              const problem = fileProblem(copyFile, taken);
              if (problem) refuse('file', problem);
              // The page may show an older commit than the branch has now: the newest is read then.
              const text = await api.fileText(project.id, file, commit).catch(async () => {
                const now = (await api.projects(workspace)).find((p) => p.id === project.id);
                if (!now?.commit) throw new Error('The flow could not be read');
                return api.fileText(project.id, file, now.commit);
              });
              await api.saveFiles(project.id, {
                branch: project.gitRef,
                message: `Copy the flow ${name} as ${copyName.trim()}`,
                changes: [
                  {
                    op: 'write',
                    path: copyFile,
                    text: copiedFlowText(text, copyName.trim(), copyKey, createIdFactory()()),
                  },
                ],
              });
              navigate(flowPage(workspace, project.key, copyFile));
            }}
          >
            <Field
              label="Name"
              name="name"
              value={copyName}
              onChange={(e) => setCopyName(e.target.value)}
              required
            />
            <Field
              label="File"
              name="file"
              value={copyFile}
              onChange={(e) => setCopyPath(e.target.value)}
              required
              spellCheck={false}
              hint={`One commit on ${project.gitRef}; the copy gets its own id and key.`}
            />
          </Form>
        </section>
      )}
      {doing === 'delete' && (
        <section className="panel danger-zone" aria-labelledby="delete-flow">
          <h2 id="delete-flow">Delete the flow</h2>
          <p>
            Deletes <code>{file}</code> in one commit on {project.gitRef}. Its runs stay in the
            history.
          </p>
          {usedBy.length > 0 && (
            <p className="notice warn">
              Launch configurations run it: {usedBy.join(', ')}. They cannot launch once it is gone:
              delete or change them too.
            </p>
          )}
          {!!schedules?.length && (
            <p className="notice warn" data-schedules>
              {schedules.length === 1 ? 'The schedule' : 'The schedules'}{' '}
              {schedules.map((s) => s.name).join(', ')} {schedules.length === 1 ? 'fires' : 'fire'}{' '}
              it: {schedules.length === 1 ? 'it is' : 'they are'} turned off with it.
            </p>
          )}
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            <button
              type="button"
              className="danger"
              disabled={deleting}
              onClick={async () => {
                if (deleting) return;
                setDeleting(true);
                setError(undefined);
                try {
                  await api.saveFiles(project.id, {
                    branch: project.gitRef,
                    message: `Delete the flow ${name}`,
                    changes: [{ op: 'delete', path: file }],
                  });
                  // AFS-187: the server turns the schedules off in the same save.
                  navigate(
                    `/w/${encodeURIComponent(workspace)}/${encodeURIComponent(project.key)}`,
                  );
                } catch (e) {
                  setError(messageOf(e));
                  setDeleting(false);
                }
              }}
            >
              Delete the flow
            </button>
            <button type="button" onClick={() => onDone()}>
              Cancel
            </button>
          </div>
        </section>
      )}
    </>
  );
}

/** A menu's items, in order. */
const menuItems = (box: HTMLElement | null) => [
  ...(box?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
];

/**
 * AFS-110: More (⋯) in a flow page's head: Copy… and Delete…, so they take no row of their own.
 * Closes on a pick, a click elsewhere or Escape. AFS-195: a menu as the keyboard expects one:
 * opened, its first item has focus; the arrows, Home and End move; Escape gives focus back to More.
 */

export function FlowFileMenu({
  onPick,
  mayChange = true,
}: {
  onPick(what: 'copy' | 'delete' | 'history'): void;
  /** AFS-123: Copy and Delete are for who may change the project's files; History for anyone. */
  mayChange?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    menuItems(box.current)[0]?.focus();
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Focus was in the menu: it goes back to More, not to the page's body.
      if (box.current?.contains(document.activeElement)) button.current?.focus();
      setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  const pick = (what: 'copy' | 'delete' | 'history') => {
    setOpen(false);
    onPick(what);
  };
  return (
    <div className="more-menu" ref={box}>
      <button
        ref={button}
        type="button"
        className="icon-button"
        aria-label="More"
        title={
          mayChange ? 'More: history, copy or delete the flow' : 'More: the history of the flow'
        }
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="more" />
      </button>
      {open && (
        <div
          className="more-menu-list"
          role="menu"
          tabIndex={-1}
          onKeyDown={(e) => {
            const all = menuItems(box.current);
            const at = all.indexOf(document.activeElement as HTMLElement);
            const to =
              e.key === 'ArrowDown'
                ? (at + 1) % all.length
                : e.key === 'ArrowUp'
                  ? (at - 1 + all.length) % all.length
                  : e.key === 'Home'
                    ? 0
                    : e.key === 'End'
                      ? all.length - 1
                      : undefined;
            if (to !== undefined) {
              e.preventDefault();
              all[to]?.focus();
            } else if (e.key === 'Tab') setOpen(false);
          }}
        >
          <button type="button" role="menuitem" onClick={() => pick('history')}>
            History
          </button>
          {mayChange ? (
            <>
              <button type="button" role="menuitem" onClick={() => pick('copy')}>
                Copy the flow…
              </button>
              <button
                type="button"
                role="menuitem"
                className="danger"
                onClick={() => pick('delete')}
              >
                Delete the flow…
              </button>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
