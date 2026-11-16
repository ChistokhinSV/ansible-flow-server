// Execution environments on the pages (AFS-32): a workspace's list, and an environment's page with
// what a launch gets now, what that image holds, its spec (collections with a version, a range or
// latest; pip and Debian packages; certificates), Build, the builds with their logs (followed while
// one goes), the ansible-builder file, and Delete. rw on the workspace changes and builds; ro reads.
import { useCallback, useEffect, useId, useState } from 'react';
import { api, type Environment, type EnvironmentBuild, type EnvironmentSpec } from './api';
import { Link, navigate } from './router';
import { Field, Fold, Form, Loading, messageOf, PageHead, Time, useLoad } from './ui';

const STATE_TONE: Record<string, string> = {
  done: 'ok',
  failed: 'bad',
  building: 'busy',
  queued: 'busy',
};
const STATE_LABEL: Record<string, string> = {
  done: 'built',
  failed: 'failed',
  building: 'building',
  queued: 'waiting',
};
export const environmentAddress = (workspace: string, id: string) =>
  `/w/${encodeURIComponent(workspace)}/environments/${encodeURIComponent(id)}`;

function BuildBadge({ build }: { build?: EnvironmentBuild }) {
  if (!build) return <span className="badge">not built</span>;
  return (
    <span className={`badge ${STATE_TONE[build.state] ?? ''}`}>
      {STATE_LABEL[build.state] ?? build.state}
    </span>
  );
}

/** A workspace's environments, and a form to add one. */
export function WorkspaceEnvironments({
  workspace,
  mayManage,
}: {
  workspace: string;
  mayManage: boolean;
}) {
  const list = useLoad(() => api.environments(workspace), [workspace]);
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState({ name: '', kind: 'spec' as 'spec' | 'image', image: '' });
  const kindId = useId();
  if (list.error && !list.data) return null;
  return (
    <section className="panel" aria-labelledby="environments">
      <div className="panel-head">
        <h2 id="environments">Execution environments</h2>
        {mayManage && !adding && (
          <button type="button" onClick={() => setAdding(true)}>
            Add environment
          </button>
        )}
      </div>
      <p className="muted">
        The images runs happen in: built here from a list of collections and packages, or an image
        that exists already. A launch configuration chooses one.
      </p>
      {adding && (
        <Form
          submit="Add"
          onCancel={() => setAdding(false)}
          onSubmit={async () => {
            const made = await api.addEnvironment(workspace, {
              name: input.name.trim(),
              kind: input.kind,
              ...(input.kind === 'image' ? { image: input.image.trim() } : {}),
            });
            navigate(environmentAddress(workspace, made.id));
          }}
        >
          <Field
            label="Name"
            value={input.name}
            onChange={(e) => setInput({ ...input, name: e.target.value })}
            required
            pattern="[a-z0-9][a-z0-9._\-]{0,62}"
            hint="Lower-case letters, digits, dots, dashes: it is part of the image's name."
          />
          <div className="field">
            <label htmlFor={kindId}>Kind</label>
            <select
              id={kindId}
              value={input.kind}
              onChange={(e) => setInput({ ...input, kind: e.target.value as 'spec' | 'image' })}
            >
              <option value="spec">built here from a spec</option>
              <option value="image">an image that exists already</option>
            </select>
          </div>
          {input.kind === 'image' && (
            <Field
              label="Image"
              value={input.image}
              onChange={(e) => setInput({ ...input, image: e.target.value })}
              required
              spellCheck={false}
              placeholder="registry.example.net/ee/network:2.19"
            />
          )}
        </Form>
      )}
      <Loading state={list} />
      {list.data?.length === 0 && (
        <p className="empty">No environment yet: runs use the server's default image.</p>
      )}
      {!!list.data?.length && (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Environment</th>
                <th scope="col">Image runs get</th>
                <th scope="col">Newest build</th>
                <th scope="col">Used by</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((e) => (
                <tr key={e.id}>
                  <td>
                    <Link to={environmentAddress(workspace, e.id)}>{e.name}</Link>
                    <div className="muted">
                      {e.kind === 'spec'
                        ? `${e.spec?.collections.length ?? 0} collection${e.spec?.collections.length === 1 ? '' : 's'}`
                        : 'existing image'}
                    </div>
                  </td>
                  <td>
                    {e.current ? (
                      <code className="wrap">{e.current}</code>
                    ) : (
                      <span className="muted">none yet</span>
                    )}
                  </td>
                  <td>
                    <BuildBadge build={e.latest} />
                  </td>
                  <td>{e.usedBy || 'nothing'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** What saving the spec form sends; also what the saved spec would send, to tell unsaved changes. */
function specBody(
  keep: number,
  spec: Omit<EnvironmentSpec, 'caCertificates'> & { caCertificates?: string },
) {
  return {
    keep,
    spec: {
      baseImage: spec.baseImage,
      ansibleCore: spec.ansibleCore,
      collections: spec.collections
        .filter((c) => c.name.trim())
        .map((c) => ({ name: c.name, version: c.version })),
      python: spec.python,
      system: spec.system,
      ...(spec.caCertificates?.trim() ? { caCertificates: spec.caCertificates } : {}),
    },
  };
}

/** Saves the spec form's changes; given to the page while there are unsaved ones (AFS-92). */
export type SaveSpec = () => Promise<Environment>;

function SpecForm({
  env,
  onSaved,
  onDraft,
}: {
  env: Environment;
  onSaved(e: Environment): void;
  /** Told whether the form holds changes not saved, with how to save them. */
  onDraft(save: SaveSpec | undefined): void;
}) {
  const spec = env.spec as EnvironmentSpec;
  const [base, setBase] = useState(spec.baseImage);
  const [core, setCore] = useState(spec.ansibleCore);
  const [collections, setCollections] = useState(
    spec.collections.length ? spec.collections : [{ name: '', version: 'latest' }],
  );
  const [python, setPython] = useState(spec.python.join('\n'));
  const [system, setSystem] = useState(spec.system.join('\n'));
  const [ca, setCa] = useState(spec.caCertificates ?? '');
  const [keep, setKeep] = useState(env.keep);
  const [saved, setSaved] = useState(false);
  const [more, setMore] = useState(!!spec.caCertificates);
  const ids = { python: useId(), system: useId(), ca: useId() };
  const set = (i: number, part: 'name' | 'version', v: string) =>
    setCollections(collections.map((c, j) => (j === i ? { ...c, [part]: v } : c)));
  const body = specBody(keep, {
    baseImage: base,
    ansibleCore: core,
    collections,
    python: lines(python),
    system: lines(system),
    caCertificates: ca,
  });
  const draft = JSON.stringify(body);
  const dirty = draft !== JSON.stringify(specBody(env.keep, spec));
  const save = async () => {
    const changed = await api.changeEnvironment(env.id, body);
    onSaved(changed);
    return changed;
  };
  // The page's Build button builds the saved spec; while the form differs it offers to save first.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `save` is new each render; `draft` says when it changes
  useEffect(() => onDraft(dirty ? save : undefined), [dirty, draft, onDraft]);
  return (
    <Form
      wide
      submit="Save the spec"
      onSubmit={async () => {
        setSaved(false);
        await save();
        setSaved(true);
      }}
    >
      <div className="pair">
        <Field
          label="ansible-core"
          value={core}
          onChange={(e) => setCore(e.target.value)}
          required
          hint="2.19 is the newest 2.19.x; 2.19.3 exactly."
        />
        <Field
          label="Images kept"
          type="number"
          min={1}
          max={50}
          value={keep}
          onChange={(e) => setKeep(Number(e.target.value))}
          hint="Older builds' images are removed from the engine."
        />
      </div>
      {/* AFS-94: collections are a table (one line of headings, a row each), with what adds a row
          under it. */}
      <fieldset className="spec-collections">
        <legend>Collections</legend>
        {collections.length > 0 && (
          <div className="spec-rows">
            <div className="spec-row spec-head" aria-hidden="true">
              <span>Name</span>
              <span>Version</span>
              <span />
            </div>
            {collections.map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity but their place
              <div key={i} className="spec-row">
                <input
                  aria-label={`Collection ${i + 1}`}
                  value={c.name}
                  onChange={(e) => set(i, 'name', e.target.value)}
                  placeholder="cisco.ios"
                  spellCheck={false}
                />
                <input
                  aria-label={`Version ${i + 1}`}
                  value={c.version}
                  onChange={(e) => set(i, 'version', e.target.value)}
                  placeholder="latest"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="link"
                  aria-label={`Remove collection ${i + 1}`}
                  onClick={() => setCollections(collections.filter((_, j) => j !== i))}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
        <CollectionSearch
          onAdd={(name) =>
            setCollections((now) =>
              now.some((c) => c.name === name)
                ? now
                : [...now.filter((c) => c.name.trim()), { name, version: 'latest' }],
            )
          }
          onBlank={() => setCollections([...collections, { name: '', version: 'latest' }])}
        />
        <small className="muted">
          A version (11.6.0), a range as requirements.yml writes it (&gt;=11.0.0,&lt;12), or latest:
          settled at each build.
        </small>
      </fieldset>
      <div className="pair">
        <div className="field">
          <label htmlFor={ids.python}>Python packages</label>
          <textarea
            id={ids.python}
            rows={4}
            className="mono"
            value={python}
            onChange={(e) => setPython(e.target.value)}
            spellCheck={false}
            placeholder="netaddr>=1.3"
          />
          <small className="muted">One per line, as pip reads them: a name and versions.</small>
        </div>
        <div className="field">
          <label htmlFor={ids.system}>Debian packages</label>
          <textarea
            id={ids.system}
            rows={4}
            className="mono"
            value={system}
            onChange={(e) => setSystem(e.target.value)}
            spellCheck={false}
            placeholder="iputils-ping"
          />
          <small className="muted">One per line, as apt names them.</small>
        </div>
      </div>
      {/* Rarely changed: folded until asked for, open when certificates are set. */}
      <Fold summary="Base image and certificate authorities" open={more} onToggle={setMore}>
        <div className="form wide">
          <Field
            label="Base image"
            value={base}
            onChange={(e) => setBase(e.target.value)}
            required
            spellCheck={false}
            hint="A Debian-based Python image; the default is the one afd-ee uses."
          />
          <div className="field">
            <label htmlFor={ids.ca}>Extra certificate authorities</label>
            <textarea
              id={ids.ca}
              rows={4}
              className="mono"
              value={ca}
              onChange={(e) => setCa(e.target.value)}
              spellCheck={false}
              placeholder="-----BEGIN CERTIFICATE-----"
            />
            <small className="muted">
              PEM. Trusted in the image: by pip, ansible-galaxy and the hosts runs reach.
            </small>
          </div>
        </div>
      </Fold>
      {saved && (
        <p className="notice ok" role="status">
          Saved. Build to make an image from it.
        </p>
      )}
    </Form>
  );
}

function Builds({
  env,
  builds,
  reload,
}: {
  env: Environment;
  builds: EnvironmentBuild[];
  reload(): void;
}) {
  const [open, setOpen] = useState<string>();
  const [log, setLog] = useState('');
  const going = builds.some((b) => b.state === 'queued' || b.state === 'building');
  // While a build goes, its state and log are looked at again every few seconds.
  useEffect(() => {
    if (!going) return;
    const timer = setInterval(reload, 3000);
    return () => clearInterval(timer);
  }, [going, reload]);
  useEffect(() => {
    if (!open) return;
    let current = true;
    const read = () => api.buildLog(env.id, open).then((t) => current && setLog(t));
    void read();
    const timer = going ? setInterval(read, 3000) : undefined;
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [open, going, env.id]);
  if (!builds.length) return <p className="empty">Not built yet.</p>;
  return (
    <>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Build</th>
              <th scope="col">State</th>
              <th scope="col">Image</th>
              <th scope="col">By</th>
              <th scope="col">
                <span className="sr-only">Log</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {builds.map((b) => (
              <tr key={b.id}>
                <td>
                  {b.number}
                  <div className="muted">
                    <Time at={b.createdAt} />
                  </div>
                </td>
                <td>
                  <BuildBadge build={b} />
                  {b.pruned && <div className="muted">image removed</div>}
                  {b.error && <div className="bad-text">{b.error}</div>}
                </td>
                <td>{b.image ? <code className="wrap">{b.image}</code> : ''}</td>
                <td>{b.by}</td>
                <td>
                  <button
                    type="button"
                    aria-expanded={open === b.id}
                    onClick={() => setOpen(open === b.id ? undefined : b.id)}
                  >
                    {open === b.id ? 'Hide log' : 'Log'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && (
        <>
          <h3>Log of build {builds.find((b) => b.id === open)?.number}</h3>
          <pre className="log">{log || '(nothing yet)'}</pre>
        </>
      )}
    </>
  );
}

/**
 * The newest build's outcome under the page's title, so the Build button coming back after a build
 * does not read as "nothing happened" (AFS-91): built and in use, failed (and what runs get
 * meanwhile), still going, or not built; and what building again would change.
 */
function BuildStatus({ env, newest }: { env: Environment; newest?: EnvironmentBuild }) {
  if (!newest)
    return (
      <p className="notice" role="status">
        Not built yet: runs cannot use this environment until a build is done.
      </p>
    );
  // `latest`, a range or `2.19` may settle on newer versions at the next build; exact ones do not.
  const exact = (v: string) => /^(==)?\d+\.\d+\.\d+$/.test(v.trim());
  const floating =
    env.kind === 'spec' &&
    !!env.spec &&
    (!exact(env.spec.ansibleCore) || env.spec.collections.some((c) => !exact(c.version)));
  const changed = env.kind === 'spec' && env.updatedAt > newest.createdAt;
  if (newest.state === 'queued' || newest.state === 'building')
    return (
      <p className="notice" role="status">
        Build {newest.number} is {newest.state === 'queued' ? 'waiting to start' : 'building'}
        {newest.startedAt && (
          <>
            {' '}
            (started <Time at={newest.startedAt} />)
          </>
        )}
        . Runs get {env.current ? 'the previous image' : 'no image'} until it is done.
      </p>
    );
  if (newest.state === 'failed')
    return (
      <p className="notice error" role="status">
        Build {newest.number} failed <Time at={newest.endedAt ?? newest.createdAt} />
        {newest.error ? `: ${newest.error}` : ''}.{' '}
        {env.current ? 'Runs still get the image of an earlier build.' : 'Runs get no image yet.'}
      </p>
    );
  return (
    <p className={`notice ${changed ? 'warn' : 'ok'}`} role="status">
      Built: build {newest.number}, <Time at={newest.endedAt ?? newest.createdAt} />
      {newest.image === env.current ? ', is the image runs get now' : ''}.{' '}
      {changed
        ? 'The spec changed after this build: build again to use the change.'
        : floating
          ? 'Building again takes the newest versions the spec allows, and makes a new image only if they changed.'
          : 'The spec has not changed since: building again gives the same versions.'}
    </p>
  );
}

export function EnvironmentPage({ workspace, id }: { workspace: string; id: string }) {
  const space = useLoad(() => api.workspace(workspace), [workspace]);
  const load = useLoad(() => api.environment(id), [id]);
  const builds = useLoad(() => api.environmentBuilds(id), [id]);
  const [env, setEnv] = useState<Environment>();
  const [error, setError] = useState<string>();
  useEffect(() => setEnv(load.data), [load.data]);
  const level = space.data?.level;
  const mayManage = level === 'admin' || level === 'rw';
  const reloadEnv = load.reload;
  const reloadBuilds = builds.reload;
  const reload = useCallback(() => {
    reloadEnv();
    reloadBuilds();
  }, [reloadEnv, reloadBuilds]);
  // Set while the spec form holds changes not saved: Build then saves them first.
  const [unsaved, setUnsaved] = useState<SaveSpec>();
  const onDraft = useCallback((save: SaveSpec | undefined) => setUnsaved(() => save), []);
  const crumbs = (
    <nav aria-label="Breadcrumb" className="crumbs">
      <Link to="/workspaces">Workspaces</Link> / <Link to={`/w/${workspace}`}>{workspace}</Link> /{' '}
      <span aria-current="page">{env?.name ?? 'environment'}</span>
    </nav>
  );
  if (!env)
    return (
      <>
        {crumbs}
        <PageHead title="Execution environment" />
        <Loading state={load} />
      </>
    );
  const going = builds.data?.some((b) => b.state === 'queued' || b.state === 'building');
  const newest = builds.data?.reduce<EnvironmentBuild | undefined>(
    (a, b) => (!a || b.number > a.number ? b : a),
    undefined,
  );
  return (
    <>
      {crumbs}
      <PageHead
        title={env.name}
        lead={env.kind === 'spec' ? 'Built here from its spec' : `The existing image ${env.image}`}
      >
        {mayManage && (
          <button
            type="button"
            className="primary"
            disabled={going}
            onClick={async () => {
              setError(undefined);
              try {
                // A build takes the saved spec: changes still in the form are saved first.
                if (unsaved) await unsaved();
                await api.buildEnvironment(env.id);
                reload();
              } catch (e) {
                setError(messageOf(e));
              }
            }}
          >
            {going
              ? 'Building…'
              : unsaved
                ? 'Save and build'
                : env.kind === 'spec'
                  ? newest
                    ? 'Build again'
                    : 'Build now'
                  : newest
                    ? 'Pull and read it again'
                    : 'Pull and read it'}
          </button>
        )}
        {env.kind === 'spec' && (
          <a
            className="button"
            href={`/api/v1/environments/${encodeURIComponent(env.id)}/execution-environment.yml`}
            download
            onClick={async (e) => {
              // The file is made from the saved spec: changes still in the form are saved first.
              if (!unsaved) return;
              e.preventDefault();
              const link = e.currentTarget;
              setError(undefined);
              try {
                await unsaved();
                const again = document.createElement('a');
                again.href = link.href;
                again.download = 'execution-environment.yml';
                again.click();
              } catch (err) {
                setError(messageOf(err));
              }
            }}
          >
            {unsaved ? 'Save and get ansible-builder file' : 'ansible-builder file'}
          </a>
        )}
      </PageHead>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {unsaved && !going && (
        <p className="notice warn" role="status">
          The spec has changes that are not saved. A build and the ansible-builder file use the
          saved spec: Save and build, or Save and get ansible-builder file, saves them first.
        </p>
      )}
      {builds.data && <BuildStatus env={env} newest={newest} />}
      <div className={env.kind === 'spec' ? 'env' : 'env one'}>
        <section className="panel env-now" aria-labelledby="now">
          <h2 id="now">What runs get now</h2>
          <dl className="facts">
            <dt>Image</dt>
            <dd>
              {env.current ? (
                <code className="wrap">{env.current}</code>
              ) : (
                <span className="muted">none yet: build it</span>
              )}
            </dd>
            <dt>ansible-core</dt>
            <dd>{env.catalog?.ansibleCore ?? <span className="muted">not read yet</span>}</dd>
            <dt>Used by</dt>
            <dd>
              {env.usedBy
                ? `${env.usedBy} launch configuration${env.usedBy === 1 ? '' : 's'}`
                : 'nothing'}
            </dd>
          </dl>
          {env.catalog && (
            <>
              <h3>Collections in the image</h3>
              {Object.keys(env.catalog.collections).length === 0 ? (
                <p className="muted">None besides ansible.builtin.</p>
              ) : (
                <ul className="tight">
                  {Object.entries(env.catalog.collections)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([name, version]) => (
                      <li key={name}>
                        <code>{name}</code> {version}
                      </li>
                    ))}
                </ul>
              )}
            </>
          )}
        </section>
        {env.kind === 'spec' && env.spec && (
          <section className="panel env-spec" aria-labelledby="spec">
            <h2 id="spec">Spec</h2>
            {mayManage ? (
              <SpecForm key={env.id} env={env} onSaved={setEnv} onDraft={onDraft} />
            ) : (
              <dl className="facts">
                <dt>ansible-core</dt>
                <dd>{env.spec.ansibleCore}</dd>
                <dt>Collections</dt>
                <dd>
                  {env.spec.collections.map((c) => `${c.name} ${c.version}`).join(', ') || 'none'}
                </dd>
                <dt>Python</dt>
                <dd>{env.spec.python.join(', ') || 'none'}</dd>
                <dt>Debian</dt>
                <dd>{env.spec.system.join(', ') || 'none'}</dd>
              </dl>
            )}
          </section>
        )}
      </div>
      <section aria-labelledby="builds">
        <h2 id="builds">Builds</h2>
        <Loading state={builds} />
        {builds.data && <Builds env={env} builds={builds.data} reload={reload} />}
      </section>
      {/* AFS-94: what cannot be undone is last on the page, away from Build. */}
      {mayManage && (
        <section className="panel" aria-labelledby="delete">
          <h2 id="delete">Delete</h2>
          <p className="muted">
            Its builds and their images go with it.
            {env.usedBy
              ? ` ${env.usedBy} launch configuration${env.usedBy === 1 ? ' uses' : 's use'} it.`
              : ''}
          </p>
          <button
            type="button"
            className="danger"
            onClick={async () => {
              if (
                !window.confirm(`Delete the environment ${env.name}, its builds and their images?`)
              )
                return;
              setError(undefined);
              try {
                await api.deleteEnvironment(env.id);
                navigate(`/w/${workspace}`);
              } catch (e) {
                setError(messageOf(e));
              }
            }}
          >
            Delete the environment
          </button>
        </section>
      )}
    </>
  );
}

/**
 * Collections on the collection server (AFS-33), to add to a spec. When it cannot be reached, it
 * says so: a name and version can still be typed.
 */
function CollectionSearch({ onAdd, onBlank }: { onAdd(name: string): void; onBlank(): void }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ name: string; version: string; description?: string }[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const id = useId();
  const search = async () => {
    if (q.trim().length < 2 || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      setFound(await api.galaxySearch(q.trim()));
    } catch (e) {
      setFound(undefined);
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="field">
      <label htmlFor={id}>Add a collection</label>
      <div className="spec-add">
        <input
          id={id}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void search();
            }
          }}
          placeholder="Find on the collection server: ios, netcommon, aws"
        />
        <button type="button" onClick={() => void search()} disabled={busy}>
          {busy ? 'Looking…' : 'Search'}
        </button>
        <button type="button" onClick={onBlank}>
          Add an empty row
        </button>
      </div>
      {error && (
        <p className="bad-text" role="status">
          {error}
        </p>
      )}
      {found && found.length === 0 && <p className="muted">Nothing found.</p>}
      {found && found.length > 0 && (
        <ul className="tight" aria-label="Collections found">
          {found.map((c) => (
            <li key={c.name}>
              <button type="button" onClick={() => onAdd(c.name)} aria-label={`Add ${c.name}`}>
                Add
              </button>{' '}
              <code>{c.name}</code> {c.version}
              {c.description && <span className="muted"> · {c.description}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * What a launch configuration's flow needs, against its environment (AFS-33): each collection with
 * where the need comes from, what the image has, and why not; and an environment made for the flow.
 */
export function EnvironmentCheck({
  config,
  workspace,
  mayManage,
}: {
  config: string;
  workspace: string;
  mayManage: boolean;
}) {
  const check = useLoad(() => api.environmentCheck(config), [config]);
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const c = check.data;
  return (
    <section className="panel" aria-labelledby="needs">
      <h2 id="needs">What the flow needs</h2>
      <Loading state={check} />
      {c && (
        <>
          <p className="muted">
            From its steps
            {c.requirementsFile ? " and the project's collections/requirements.yml" : ''}, at{' '}
            <code>{c.commit.slice(0, 12)}</code>
            {c.environment ? (
              <>
                , against{' '}
                <Link to={environmentAddress(workspace, c.environment.id)}>
                  {c.environment.name}
                </Link>
                {c.environment.ansibleCore ? ` (ansible-core ${c.environment.ansibleCore})` : ''}.
              </>
            ) : (
              '. The configuration has no environment to check against.'
            )}
          </p>
          {c.lines.length === 0 ? (
            <p className="muted">Only what comes with ansible-core.</p>
          ) : (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Collection</th>
                    <th scope="col">Needs</th>
                    <th scope="col">Used by</th>
                    {c.environment && <th scope="col">In the image</th>}
                  </tr>
                </thead>
                <tbody>
                  {c.lines.map((l) => (
                    <tr key={l.name}>
                      <td>
                        <code>{l.name}</code>
                      </td>
                      <td>
                        {l.wants}
                        <div className="muted">
                          {l.from === 'flow'
                            ? 'the steps'
                            : l.from === 'requirements'
                              ? 'requirements.yml'
                              : 'both'}
                        </div>
                        {l.conflict && <div className="bad-text">{l.conflict}</div>}
                      </td>
                      <td>
                        {l.nodes.join(', ') || <span className="muted">requirements.yml</span>}
                      </td>
                      {c.environment && (
                        <td>
                          <span className={`badge ${l.ok ? 'ok' : 'bad'}`}>
                            {l.ok ? l.has : (l.has ?? 'missing')}
                          </span>
                          {l.why && <div className="muted">{l.why}</div>}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {c.environment && c.lines.length > 0 && (
            <p className={`notice ${c.ok ? 'ok' : 'error'}`} role="status">
              {c.ok
                ? 'The environment holds everything the flow needs.'
                : `${c.lines.filter((l) => !l.ok).length} of ${c.lines.length} not as needed: the run may fail where they are used.`}
            </p>
          )}
          {mayManage && c.lines.length > 0 && !c.ok && (
            <form
              className="form"
              onSubmit={async (e) => {
                e.preventDefault();
                if (busy) return;
                setBusy(true);
                setError(undefined);
                try {
                  const made = await api.environmentForFlow(config, name.trim());
                  navigate(environmentAddress(workspace, made.id));
                } catch (err) {
                  setError(messageOf(err));
                  setBusy(false);
                }
              }}
            >
              <Field
                label="Make an environment for this flow"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                placeholder="hello-ee"
                hint="Its spec is what the flow needs; it is built right away. Then choose it in the configuration."
              />
              {error && (
                <p className="notice error" role="alert">
                  {error}
                </p>
              )}
              <div className="actions">
                <button type="submit" disabled={busy}>
                  {busy ? 'Making…' : 'Make and build it'}
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}
