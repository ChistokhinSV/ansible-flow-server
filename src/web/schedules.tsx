// Schedules on a launch configuration's page (AFS-34): when it runs by itself, with the next times
// and how the last fire went; rw on the flow adds, changes, pauses and deletes them; an
// administrator hands one to a service account. The cron's next times are shown as it is typed.
// AFS-139: a schedule's rule is in its own time zone (a cron, a one-time At); every time the page
// shows is in this browser's zone, named. The list follows fires and their runs while it is open.
import { useEffect, useId, useState } from 'react';
import {
  ApiError,
  api,
  type LaunchForm,
  type Schedule,
  type ScheduleInput,
  type User,
} from './api';
import { Link } from './router';
import { ACTIVE, RunWords } from './runs';
import {
  browserZone,
  COMMIT_PATTERN,
  COMMIT_TITLE,
  Field,
  Form,
  Labelled,
  Loading,
  messageOf,
  Time,
  useLoad,
  useRefresh,
} from './ui';

/** What a configuration launches: its pinned commit, else the newest of its branch. */
interface Takes {
  pinned?: string;
  branch: string;
}

const RESULT_TONE: Record<string, string> = {
  ok: 'ok',
  failed: 'bad',
  refused: 'bad',
  skipped: '',
};
const RESULT_LABEL: Record<string, string> = {
  ok: 'launched',
  skipped: 'skipped',
  refused: 'refused',
  failed: 'failed',
};

/** How far (ms) a time zone's clocks are ahead of UTC at a moment; 0 for a zone Intl lacks. */
function zoneOffset(zone: string, at: number): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(at));
  } catch {
    return 0;
  }
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wall = Date.UTC(
    n('year'),
    n('month') - 1,
    n('day'),
    n('hour') % 24,
    n('minute'),
    n('second'),
  );
  return wall - Math.floor(at / 1000) * 1000;
}

/**
 * AFS-139: the moment a `datetime-local` value ("2026-11-19T04:00") names on the clocks of
 * `zone`, as an ISO time; '' when it is no time. Summer time is followed: the offset is the one
 * the zone has then, worked out twice for a time near a change.
 */
export function zonedToIso(local: string, zone: string): string {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/.exec(local);
  if (!m) return '';
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const first = wall - zoneOffset(zone, wall);
  return new Date(wall - zoneOffset(zone, first)).toISOString();
}

/** AFS-139: a `datetime-local` value for a time, on the clocks of `zone`. */
export function zonedInput(iso: string | undefined, zone: string): string {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(at)) return '';
  return new Date(at + zoneOffset(zone, at)).toISOString().slice(0, 16);
}

/**
 * The next times a cron fires, looked up as it is typed (a moment after the last key). AFS-140:
 * what is wrong is given back with the field it is about (the cron or the time zone), for that
 * field to show.
 */
function useCronTimes(cron: string, timezone: string) {
  const [state, setState] = useState<{
    times?: string[];
    /** AFS-150: each problem at its field: a wrong zone and a wrong cron are both said. */
    problems?: { field: string; message: string }[];
  }>({});
  useEffect(() => {
    if (!cron.trim()) return setState({});
    const timer = setTimeout(() => {
      api.scheduleTimes(cron.trim(), timezone.trim() || 'UTC').then(
        (r) =>
          setState(
            r.problems?.length
              ? {
                  problems: r.problems.map((p) => ({
                    field: p.field === 'timezone' ? 'timezone' : 'cron',
                    message: p.message,
                  })),
                }
              : { times: r.times },
          ),
        (e) =>
          setState({
            problems: [
              {
                field:
                  e instanceof ApiError && e.details.field === 'timezone' ? 'timezone' : 'cron',
                message: messageOf(e),
              },
            ],
          }),
      );
    }, 400);
    return () => clearTimeout(timer);
  }, [cron, timezone]);
  return state;
}

/** AFS-150: true when the browser knows the time zone (a one-time At is shown in your time). */
function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function CronPreview({ times }: { times?: string[] }) {
  if (!times) return null;
  return (
    <p className="muted" role="status">
      Next, in your time:{' '}
      {times.slice(0, 3).map((t, i) => (
        <span key={t}>
          {i > 0 && ', '}
          <Time at={t} />
        </span>
      ))}
    </p>
  );
}

function ScheduleForm({
  config,
  form,
  takes,
  editing,
  onDone,
  onCancel,
}: {
  config: string;
  form?: LaunchForm;
  /** AFS-150: what the configuration launches: its pinned commit, else its branch. */
  takes: Takes;
  editing?: Schedule;
  onDone(): void;
  onCancel(): void;
}) {
  const [input, setInput] = useState({
    name: editing?.name ?? '',
    kind: editing?.kind ?? ('cron' as 'cron' | 'once'),
    cron: editing?.cron ?? '0 3 * * 1-5',
    timezone: editing?.timezone ?? browserZone(),
    onceAt: zonedInput(editing?.onceAt, editing?.timezone ?? browserZone()),
    mode: editing?.mode ?? '',
    commit: editing?.commit ?? '',
    missed: editing?.missed ?? 'once',
    overlap: editing?.overlap ?? 'skip',
  });
  const [inputs, setInputs] = useState<Record<string, string>>(editing?.inputs ?? {});
  const ids = { kind: useId(), mode: useId(), missed: useId(), overlap: useId() };
  const set = (key: keyof typeof input) => (e: { target: { value: string } }) =>
    setInput((before) => ({ ...before, [key]: e.target.value }));
  // A schedule runs with nobody to type a secret: those inputs are not offered.
  const fields = (form?.fields ?? []).filter((f) => !f.secret);
  const preview = useCronTimes(input.kind === 'cron' ? input.cron : '', input.timezone);
  const live = (field: string) => preview.problems?.find((p) => p.field === field)?.message;
  const zone = input.timezone.trim() || 'UTC';
  // AFS-150: the hints name the zone only when it is one: a wrong one is said at its own field.
  const zoneWords = live('timezone') || !knownZone(zone) ? 'the time zone above' : zone;
  const onceIso = input.kind === 'once' && knownZone(zone) ? zonedToIso(input.onceAt, zone) : '';
  return (
    <Form
      open
      submit={editing ? 'Save' : 'Add schedule'}
      onCancel={onCancel}
      onSubmit={async () => {
        const body: ScheduleInput = {
          name: input.name.trim(),
          kind: input.kind,
          timezone: input.timezone.trim(),
          ...(input.kind === 'cron'
            ? { cron: input.cron.trim() }
            : // AFS-139: At is on the clocks of the schedule's time zone, as its hint says.
              { onceAt: zonedToIso(input.onceAt, input.timezone.trim() || 'UTC') }),
          mode: input.mode ? (input.mode as 'check' | 'real') : null,
          commit: input.commit.trim() || null,
          missed: input.missed as 'once' | 'skip',
          overlap: input.overlap as 'skip' | 'queue',
          inputs: Object.fromEntries(Object.entries(inputs).filter(([, v]) => v.trim() !== '')),
        };
        if (editing) await api.changeSchedule(config, editing.id, body);
        else await api.addSchedule(config, body);
        onDone();
      }}
    >
      <Field
        label="Name"
        name="name"
        value={input.name}
        onChange={set('name')}
        required
        maxLength={100}
      />
      <div className="field">
        <label htmlFor={ids.kind}>Runs</label>
        <select id={ids.kind} value={input.kind} onChange={set('kind')}>
          <option value="cron">on a cron</option>
          <option value="once">once, at a set time</option>
        </select>
      </div>
      {/* AFS-139: the zone first: the cron and the At below are read on its clocks. */}
      <Field
        label="Time zone"
        name="timezone"
        value={input.timezone}
        onChange={set('timezone')}
        required
        problem={live('timezone')}
        hint={`Like Europe/Berlin or UTC: summer time is followed. Yours is ${browserZone()}.`}
      />
      {input.kind === 'cron' ? (
        <>
          <Field
            label="Cron"
            name="cron"
            value={input.cron}
            onChange={set('cron')}
            required
            spellCheck={false}
            problem={live('cron')}
            hint={`minute hour day month weekday, in ${zoneWords}: 0 3 * * 1-5 is 03:00 on weekdays. At most once a minute.`}
          />
          <CronPreview times={preview.times} />
        </>
      ) : (
        <>
          <Field
            label="At"
            name="onceAt"
            type="datetime-local"
            value={input.onceAt}
            onChange={set('onceAt')}
            required
            hint={`In ${zoneWords}.`}
          />
          {/* AFS-150: as a cron's next times are: the moment in this browser's time. */}
          {onceIso && (
            <p className="muted" role="status">
              In your time: <Time at={onceIso} />
            </p>
          )}
        </>
      )}
      <div className="field">
        <label htmlFor={ids.mode}>Mode</label>
        <select id={ids.mode} value={input.mode} onChange={set('mode')}>
          <option value="">as the configuration says</option>
          <option value="check">check (nothing is changed)</option>
          <option value="real">real</option>
        </select>
      </div>
      <Field
        label="Pinned commit"
        name="commit"
        value={input.commit}
        onChange={set('commit')}
        pattern={COMMIT_PATTERN}
        title={COMMIT_TITLE}
        spellCheck={false}
        hint={`As shown here (12 digits) or in full. Empty: ${takes.pinned ? `the configuration's pinned commit (${takes.pinned.slice(0, 12)})` : `the newest commit of ${takes.branch} when it fires`}.`}
      />
      {fields.length > 0 && (
        <fieldset>
          <legend>Inputs</legend>
          {fields.map((f) => {
            const hint = [
              f.description,
              f.text
                ? "Empty: the configuration's start value."
                : f.required
                  ? 'Needed: there is no start value.'
                  : '',
            ]
              .filter(Boolean)
              .join(' ');
            const onChange = (e: { target: { value: string } }) =>
              setInputs({ ...inputs, [f.name]: e.target.value });
            // AFS-153: true or false is picked, as on the launch form, not typed.
            return f.type === 'boolean' ? (
              <Labelled
                key={f.name}
                label={f.name}
                name={`inputs.${f.name}`}
                hint={hint || undefined}
              >
                {(props) => (
                  <select {...props} value={inputs[f.name] ?? ''} onChange={onChange}>
                    <option value="">{f.text ? `the start value (${f.text})` : '(not set)'}</option>
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                )}
              </Labelled>
            ) : (
              <Field
                key={f.name}
                label={f.name}
                // AFS-150: a refusal about this input is shown at it.
                name={`inputs.${f.name}`}
                value={inputs[f.name] ?? ''}
                placeholder={f.text}
                onChange={onChange}
                hint={hint}
              />
            );
          })}
        </fieldset>
      )}
      <div className="field">
        <label htmlFor={ids.missed}>When the server was down at its time</label>
        <select id={ids.missed} value={input.missed} onChange={set('missed')}>
          <option value="once">run once when it is back</option>
          <option value="skip">skip it</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor={ids.overlap}>When its last run has not ended</label>
        <select id={ids.overlap} value={input.overlap} onChange={set('overlap')}>
          <option value="skip">skip this time</option>
          <option value="queue">queue another behind it</option>
        </select>
      </div>
    </Form>
  );
}

/** Hands a schedule to a service account (administrators). */
function HandOver({
  config,
  schedule,
  onDone,
}: {
  config: string;
  schedule: Schedule;
  onDone(): void;
}) {
  const people = useLoad(api.users, []);
  const [to, setTo] = useState('');
  const [error, setError] = useState<string>();
  const id = useId();
  const services = (people.data ?? []).filter((u) => u.service && !u.disabled);
  if (!services.length) return null;
  return (
    <div className="field">
      <label htmlFor={id}>Hand to a service account</label>
      <div className="row">
        <select id={id} value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">(choose)</option>
          {services.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name || u.login} ({u.login})
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!to}
          onClick={async () => {
            setError(undefined);
            try {
              await api.changeSchedule(config, schedule.id, { owner: to });
              onDone();
            } catch (e) {
              setError(messageOf(e));
            }
          }}
        >
          Hand over
        </button>
      </div>
      {error && <p className="bad-text">{error}</p>}
    </div>
  );
}

export function SchedulesSection({
  config,
  form,
  takes,
  mayManage,
  me,
}: {
  config: string;
  form?: LaunchForm;
  takes: Takes;
  mayManage: boolean;
  me: User;
}) {
  const list = useLoad(() => api.schedules(config), [config]);
  // AFS-139: live while open: read again when the next fire is due (Next moves on, Last says
  // what it did), every few seconds while a fired run goes, and on coming back to the page.
  useRefresh(list.reload);
  const soonest = Math.min(
    ...(list.data ?? []).flatMap((s) =>
      s.enabled && s.upcoming[0] ? [Date.parse(s.upcoming[0])] : [],
    ),
  );
  const runGoing = !!list.data?.some((s) => s.last?.runState && ACTIVE.includes(s.last.runState));
  useEffect(() => {
    if (!Number.isFinite(soonest)) return;
    // A moment after the fire, for the server to have taken it; at most a day ahead.
    const wait = Math.min(Math.max(soonest - Date.now() + 2000, 1000), 86_400_000);
    const timer = setTimeout(list.reload, wait);
    return () => clearTimeout(timer);
  }, [soonest, list.reload]);
  useEffect(() => {
    if (!runGoing) return;
    const timer = setInterval(list.reload, 5000);
    return () => clearInterval(timer);
  }, [runGoing, list.reload]);
  const [open, setOpen] = useState<'new' | string>();
  const [error, setError] = useState<string>();
  const done = () => {
    setOpen(undefined);
    list.reload();
  };
  const act = async (work: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await work();
      list.reload();
    } catch (e) {
      setError(messageOf(e));
    }
  };
  return (
    <section className="panel" aria-labelledby="schedules">
      <div className="panel-head">
        <h2 id="schedules">Schedules</h2>
        {mayManage && open !== 'new' && (
          <button type="button" onClick={() => setOpen('new')}>
            Add schedule
          </button>
        )}
      </div>
      <p className="muted">
        Runs this configuration by itself. A run is launched as the schedule's owner, whose access
        is checked each time.
      </p>
      {open === 'new' && (
        <ScheduleForm
          config={config}
          form={form}
          takes={takes}
          onDone={done}
          onCancel={() => setOpen(undefined)}
        />
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <Loading state={list} />
      {list.data?.length === 0 && (
        <p className="empty">
          No schedule.
          {mayManage ? '' : ' Schedules are added by people with rw on the flow.'}
        </p>
      )}
      {list.data?.map((s) => (
        <article key={s.id} className="schedule" aria-label={s.name}>
          <h3>
            {s.name}{' '}
            {!s.enabled && (
              <span className="badge">{s.next || s.kind === 'cron' ? 'paused' : 'done'}</span>
            )}
          </h3>
          <dl className="facts">
            <dt>When</dt>
            <dd>
              {s.kind === 'cron' ? (
                <>
                  <code>{s.cron}</code> in {s.timezone}
                </>
              ) : (
                <>
                  once, <Time at={s.onceAt} />
                  {s.timezone !== browserZone() && (
                    <span className="muted"> (set in {s.timezone})</span>
                  )}
                </>
              )}
            </dd>
            <dt>Next</dt>
            <dd>
              {s.upcoming.length ? (
                s.upcoming.map((t, i) => (
                  <span key={t}>
                    {i > 0 && ', '}
                    <Time at={t} />
                  </span>
                ))
              ) : (
                <span className="muted">not planned</span>
              )}
            </dd>
            <dt>Runs</dt>
            <dd>
              {s.mode ?? 'as configured'}
              {s.commit ? (
                <>
                  , pinned to <code>{s.commit.slice(0, 12)}</code>
                </>
              ) : takes.pinned ? (
                // AFS-150: the schedule follows the configuration's pin.
                <>
                  , the configuration's pinned commit <code>{takes.pinned.slice(0, 12)}</code>
                </>
              ) : (
                <>
                  , newest commit of <code>{takes.branch}</code>
                </>
              )}
              {Object.keys(s.inputs).length > 0 && `, inputs ${Object.keys(s.inputs).join(', ')}`}
              <div className="muted">
                downtime: {s.missed === 'once' ? 'run once' : 'skip'}; still running:{' '}
                {s.overlap === 'skip' ? 'skip' : 'queue'}
              </div>
            </dd>
            <dt>Owner</dt>
            <dd title={s.owner.login}>{s.owner.name || s.owner.login}</dd>
            <dt>Last</dt>
            <dd>
              {s.last ? (
                <>
                  <span className={`badge ${RESULT_TONE[s.last.result] ?? ''}`}>
                    {RESULT_LABEL[s.last.result] ?? s.last.result}
                  </span>{' '}
                  <Time at={s.last.at} />
                  {/* AFS-139: the run as it stands now; the fire's words were of that moment. */}
                  {s.last.run && s.last.runState ? (
                    <div>
                      <Link to={`/runs/${s.last.run}`}>#{s.last.runNumber}</Link>{' '}
                      <RunWords state={s.last.runState} />
                    </div>
                  ) : (
                    <>
                      {s.last.detail && <div className="muted">{s.last.detail}</div>}
                      {s.last.run && <Link to={`/runs/${s.last.run}`}>Open the run</Link>}
                    </>
                  )}
                </>
              ) : (
                <span className="muted">not fired yet</span>
              )}
            </dd>
          </dl>
          {mayManage && open !== s.id && (
            <div className="actions">
              <button type="button" aria-label={`Change ${s.name}`} onClick={() => setOpen(s.id)}>
                Change
              </button>
              {(s.kind === 'cron' || s.enabled) && (
                <button
                  type="button"
                  aria-label={`${s.enabled ? 'Pause' : 'Resume'} ${s.name}`}
                  onClick={() =>
                    act(() => api.changeSchedule(config, s.id, { enabled: !s.enabled }))
                  }
                >
                  {s.enabled ? 'Pause' : 'Resume'}
                </button>
              )}
              <button
                type="button"
                className="danger"
                aria-label={`Delete ${s.name}`}
                onClick={() => {
                  if (window.confirm(`Delete the schedule "${s.name}"?`))
                    void act(() => api.deleteSchedule(config, s.id));
                }}
              >
                Delete
              </button>
            </div>
          )}
          {mayManage && open === s.id && (
            <ScheduleForm
              config={config}
              form={form}
              takes={takes}
              editing={s}
              onDone={done}
              onCancel={() => setOpen(undefined)}
            />
          )}
          {me.admin && open !== s.id && (
            <HandOver config={config} schedule={s} onDone={list.reload} />
          )}
        </article>
      ))}
    </section>
  );
}
