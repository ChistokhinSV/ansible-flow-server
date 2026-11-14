// Execution environments on the pages (AFS-32): a workspace's list, and an environment's page with
// what a launch gets now, what that image holds, its spec (collections with a version, a range or
// latest; pip and Debian packages; certificates), Build, the builds with their logs (followed while
// one goes), the ansible-builder file, and Delete. rw on the workspace changes and builds; ro reads.
import { useCallback, useEffect, useId, useState } from 'react';
import { api, type Environment, type EnvironmentBuild, type EnvironmentSpec } from './api';
import { Link, navigate } from './router';
import { Field, Form, Loading, messageOf, PageHead, Time, useLoad } from './ui';

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
                        ? `${e.spec?.collections.length ?? 0} collections`
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

function SpecForm({ env, onSaved }: { env: Environment; onSaved(e: Environment): void }) {
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
  const ids = { python: useId(), system: useId(), ca: useId() };
  const set = (i: number, part: 'name' | 'version', v: string) =>
    setCollections(collections.map((c, j) => (j === i ? { ...c, [part]: v } : c)));
  return (
    <Form
      submit="Save the spec"
      onSubmit={async () => {
        setSaved(false);
        onSaved(
          await api.changeEnvironment(env.id, {
            keep,
            spec: {
              baseImage: base,
              ansibleCore: core,
              collections: collections.filter((c) => c.name.trim()),
              python: lines(python),
              system: lines(system),
              ...(ca.trim() ? { caCertificates: ca } : {}),
            },
          }),
        );
        setSaved(true);
      }}
    >
      <Field
        label="ansible-core"
        value={core}
        onChange={(e) => setCore(e.target.value)}
        required
        hint="2.19 is the newest 2.19.x; 2.19.3 exactly."
      />
      <fieldset>
        <legend>Collections</legend>
        {collections.map((c, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity but their place
          <div key={i} className="row">
            <Field
              label={`Collection ${i + 1}`}
              value={c.name}
              onChange={(e) => set(i, 'name', e.target.value)}
              placeholder="cisco.ios"
              spellCheck={false}
            />
            <Field
              label={`Version ${i + 1}`}
              value={c.version}
              onChange={(e) => set(i, 'version', e.target.value)}
              placeholder="latest"
              spellCheck={false}
            />
            <button
              type="button"
              aria-label={`Remove collection ${i + 1}`}
              onClick={() => setCollections(collections.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setCollections([...collections, { name: '', version: 'latest' }])}
        >
          Add a collection
        </button>
        <p className="muted">
          A version (11.6.0), a range as requirements.yml writes it (&gt;=11.0.0,&lt;12), or latest:
          settled at each build.
        </p>
      </fieldset>
      <div className="field">
        <label htmlFor={ids.python}>Python packages</label>
        <textarea
          id={ids.python}
          rows={3}
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
          rows={2}
          className="mono"
          value={system}
          onChange={(e) => setSystem(e.target.value)}
          spellCheck={false}
          placeholder="iputils-ping"
        />
      </div>
      <div className="field">
        <label htmlFor={ids.ca}>Extra certificate authorities</label>
        <textarea
          id={ids.ca}
          rows={3}
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
      <Field
        label="Base image"
        value={base}
        onChange={(e) => setBase(e.target.value)}
        required
        spellCheck={false}
        hint="A Debian-based Python image; the default is the one afd-ee uses."
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
  const crumbs = (
    <nav aria-label="Breadcrumb" className="crumbs">
      <Link to="/">Workspaces</Link> / <Link to={`/w/${workspace}`}>{workspace}</Link> /{' '}
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
                await api.buildEnvironment(env.id);
                reload();
              } catch (e) {
                setError(messageOf(e));
              }
            }}
          >
            {going ? 'Building…' : env.kind === 'spec' ? 'Build now' : 'Pull and read it'}
          </button>
        )}
        {env.kind === 'spec' && (
          <a
            className="button"
            href={`/api/v1/environments/${encodeURIComponent(env.id)}/execution-environment.yml`}
            download
          >
            ansible-builder file
          </a>
        )}
        {mayManage && (
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
            Delete
          </button>
        )}
      </PageHead>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <div className="columns">
        <section className="panel" aria-labelledby="now">
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
          <section className="panel" aria-labelledby="spec">
            <h2 id="spec">Spec</h2>
            {mayManage ? (
              <SpecForm key={env.id} env={env} onSaved={setEnv} />
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
    </>
  );
}
