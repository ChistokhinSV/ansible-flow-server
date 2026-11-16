// AFS-109: a flow made, copied or deleted in the pages, each as one commit on the project's branch
// (the files save of AFS-78). A new flow is the designer's own template (Start wired to Done, a host
// list input); a copy gets a new id and key in its header; deleting says which launch
// configurations use the flow first.
import { createIdFactory, SLUG } from '@ansible-flow/core/flow/ids';
import { newFlowText } from '@ansible-flow/core/flow/template';
import { useEffect, useRef, useState } from 'react';
import { api, type Project } from './api';
import { navigate } from './router';
import { Field, Form, Icon, messageOf } from './ui';

const flowPage = (workspace: string, project: string, file: string) =>
  `/w/${encodeURIComponent(workspace)}/${encodeURIComponent(project)}/flow/${file
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;

/** A key from a name: lower case words joined by dashes. */
export const keyOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

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

function fileProblem(path: string): string | undefined {
  if (!/\.flow\.yaml$/.test(path)) return 'A flow file ends in .flow.yaml';
  if (path.startsWith('/') || path.split('/').some((p) => p === '..' || p === ''))
    return 'A path inside the project, such as flows/patch-web.flow.yaml';
  return undefined;
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
  const file = path ?? (key ? `flows/${key}.flow.yaml` : '');
  return (
    <section className="panel sheet" aria-label="New flow">
      <Form
        submit="Make the flow"
        onCancel={onCancel}
        onSubmit={async () => {
          if (!SLUG.test(key)) throw new Error('A name with letters or digits');
          const problem = fileProblem(file);
          if (problem) throw new Error(problem);
          await api.saveFiles(project.id, {
            branch: project.gitRef,
            message: `Add the flow ${name.trim()}`,
            changes: [
              { op: 'write', path: file, text: newFlowText(name.trim(), key, createIdFactory()) },
            ],
          });
          navigate(flowPage(workspace, project.key, file));
        }}
      >
        <Field
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={120}
          placeholder="Patch web servers"
        />
        <Field
          label="File"
          value={file}
          onChange={(e) => setPath(e.target.value)}
          required
          spellCheck={false}
          hint={`One commit on ${project.gitRef}. It starts with Start wired to Done and a host list input; edit it on its page.`}
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
  const folder = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
  const [copyPath, setCopyPath] = useState<string>();
  const copyFile = copyPath ?? (copyKey ? `${folder}${copyKey}.flow.yaml` : '');
  const [error, setError] = useState<string>();
  return (
    <>
      {doing === 'copy' && (
        <section className="panel sheet" aria-label="Copy the flow">
          <Form
            submit="Make the copy"
            onCancel={() => onDone()}
            onSubmit={async () => {
              if (!SLUG.test(copyKey)) throw new Error('A name with letters or digits');
              const problem = fileProblem(copyFile);
              if (problem) throw new Error(problem);
              if (copyFile === file) throw new Error('Another file than the flow itself');
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
              value={copyName}
              onChange={(e) => setCopyName(e.target.value)}
              required
            />
            <Field
              label="File"
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
        <section className="panel sheet" aria-label="Delete the flow">
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
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            <button
              type="button"
              className="danger"
              onClick={async () => {
                setError(undefined);
                try {
                  await api.saveFiles(project.id, {
                    branch: project.gitRef,
                    message: `Delete the flow ${name}`,
                    changes: [{ op: 'delete', path: file }],
                  });
                  navigate(
                    `/w/${encodeURIComponent(workspace)}/${encodeURIComponent(project.key)}`,
                  );
                } catch (e) {
                  setError(messageOf(e));
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

/**
 * AFS-110: More (⋯) in a flow page's head: Copy… and Delete…, so they take no row of their own.
 * Closes on a pick, a click elsewhere or Escape.
 */
export function FlowFileMenu({ onPick }: { onPick(what: 'copy' | 'delete'): void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  const pick = (what: 'copy' | 'delete') => {
    setOpen(false);
    onPick(what);
  };
  return (
    <div className="more-menu" ref={box}>
      <button
        type="button"
        className="icon-button"
        aria-label="More"
        title="More: copy or delete the flow"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="more" />
      </button>
      {open && (
        <div className="more-menu-list" role="menu">
          <button type="button" role="menuitem" onClick={() => pick('copy')}>
            Copy the flow…
          </button>
          <button type="button" role="menuitem" className="danger" onClick={() => pick('delete')}>
            Delete the flow…
          </button>
        </div>
      )}
    </div>
  );
}
