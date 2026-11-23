// AFS-201 (ADR-0038 §6): an action's settings on its own page, /actions/<id>/edit (the id is its
// launch configuration's): title, sentence, what it asks, the links (the full link with values
// too), who may run it. Changed by rw on its workspace; who may see its flow reads them. The launch
// configuration's Settings keep one line that leads here.
import { ActionRefused, actionEditAddress, ConfigActionSection } from './actions';
import { ApiError, api } from './api';
import { Link } from './router';
import { Breadcrumb, Loading, PageHead, ProjectName, useLoad, WorkspaceName } from './ui';

const configAddress = (workspace: string, project: string, config: string) =>
  `/w/${encodeURIComponent(workspace)}/${encodeURIComponent(project)}/launch/${encodeURIComponent(config)}`;

export function ActionEditPage({ id }: { id: string }) {
  const state = useLoad(() => api.configAction(id), [id]);
  // The flow's inputs, as the launch form reads them: what the action may ask. A flow that cannot
  // be read still says its fields when it can (the refusal carries the form).
  const form = useLoad(
    () =>
      api.launchForm(id).catch((e) => {
        const kept = e instanceof ApiError ? (e.details.form as { fields?: unknown }) : undefined;
        if (kept?.fields) return kept as Awaited<ReturnType<typeof api.launchForm>>;
        throw e;
      }),
    [id],
  );
  if (state.error) return <ActionRefused message={state.error} />;
  const data = state.data;
  if (!data) return <Loading state={state} />;
  const place = data.place;
  const action = data.action;
  if (!place || (!action && !data.mayManage))
    return <ActionRefused message="No such action, or it is not yours to see" />;
  return (
    <>
      <Breadcrumb>
        <Link to="/workspaces">Workspaces</Link> /{' '}
        <Link to={`/w/${encodeURIComponent(place.workspaceKey)}`}>
          <WorkspaceName workspace={place.workspaceKey} />
        </Link>{' '}
        /{' '}
        <Link
          to={`/w/${encodeURIComponent(place.workspaceKey)}/${encodeURIComponent(place.projectKey)}`}
        >
          <ProjectName workspace={place.workspaceKey} project={place.projectKey} />
        </Link>{' '}
        / {/* The configuration it runs ends the crumbs: one more part wrapped them at 1024px. */}
        <Link to={configAddress(place.workspaceKey, place.projectKey, id)}>{place.configName}</Link>
      </Breadcrumb>
      <PageHead
        help="actions.md"
        title={action ? action.title : `Make ${place.configName} an action`}
        lead={
          <>
            {action ? `${action.summary} ` : ''}
            It runs the launch configuration{' '}
            <Link to={configAddress(place.workspaceKey, place.projectKey, id)}>
              {place.configName}
            </Link>
            .
          </>
        }
      />
      {!data.mayManage && (
        <p className="notice info" role="status">
          Changing it needs rw on the workspace {place.workspaceName}.
        </p>
      )}
      {form.error && (
        <p className="notice warn" role="status">
          The flow's inputs cannot be read now: {form.error}
        </p>
      )}
      {(form.data || form.error) && (
        <ConfigActionSection
          config={id}
          name={place.configName}
          inputs={form.data?.fields ?? []}
          workspace={place.workspaceKey}
        />
      )}
      {!form.data && !form.error && <Loading state={form} />}
    </>
  );
}

/**
 * AFS-201: on a launch configuration's Settings, its action in one line: what it is called and
 * where its settings are, or (for who may make one) that it can be one.
 */
export function ConfigActionLine({ config }: { config: string }) {
  const state = useLoad(() => api.configAction(config), [config]);
  const action = state.data?.action;
  if (!state.data) return null;
  if (!action && !state.data.mayManage) return null;
  return (
    <section className="panel" aria-label="Action">
      <p data-action-line>
        {action ? (
          <>
            Action <strong>{action.title}</strong>
            {!action.enabled && <span className="badge warn"> off</span>}: its words, what it asks,
            its links and who may run it are on{' '}
            <Link to={actionEditAddress(config)}>
              {state.data.mayManage ? 'its own page' : "the action's page"}
            </Link>
            .
          </>
        ) : (
          <>
            Not an action. An action is a short form for people who do not read flows:{' '}
            <Link to={actionEditAddress(config)}>Make it an action</Link>.
          </>
        )}
      </p>
    </section>
  );
}
