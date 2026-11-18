// Schedules on a launch configuration's page (AFS-34): when it runs by itself, with the next times
// and how the last fire went; rw on the flow adds, changes, pauses and deletes them; an
// administrator hands one to a service account. The cron's next times are shown as it is typed.
// AFS-139: a schedule's rule is in its own time zone (a cron, a one-time At); every time the page
// shows is in this browser's zone, named. The list follows fires and their runs while it is open.
import { useEffect, useId, useState } from 'react';
import { api, type LaunchForm, type Schedule, type ScheduleInput, type User } from './api';
import { Link } from './router';
import { ACTIVE, RunWords } from './runs';
import { browserZone, Field, Loading, messageOf, Time, useLoad, useRefresh } from './ui';

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

/** The next times a cron fires, looked up as it is typed (a moment after the last key). */
function CronPreview({ cron, timezone }: { cron: string; timezone: string }) {
  const [state, setState] = useState<{ times?: string[]; error?: string }>({});
  useEffect(() => {
    if (!cron.trim()) return setState({});
    const timer = setTimeout(() => {
      api.scheduleTimes(cron.trim(), timezone.trim() || 'UTC').then(
        (r) => setState({ times: r.times }),
        (e) => setState({ error: messageOf(e) }),
      );
    }, 400);
    return () => clearTimeout(timer);
  }, [cron, timezone]);
  if (state.error)
    return (
      <p className="bad-text" role="status">
        {state.error}
      </p>
    );
  if (!state.times) return null;
  return (
    <p className="muted" role="status">
      Next, in your time:{' '}
      {state.times.slice(0, 3).map((t, i) => (
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
  editing,
  onDone,
  onCancel,
}: {
  config: string;
  form?: LaunchForm;
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string }>();
  const ids = { kind: useId(), mode: useId(), missed: useId(), overlap: useId() };
  const set = (key: keyof typeof input) => (e: { target: { value: string } }) =>
    setInput((before) => ({ ...before, [key]: e.target.value }));
  // A schedule runs with nobody to type a secret: those inputs are not offered.
  const fields = (form?.fields ?? []).filter((f) => !f.secret);
  const at = (field: string) => (error?.field === field ? error.message : undefined);
  return (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError(undefined);
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
        try {
          if (editing) await api.changeSchedule(config, editing.id, body);
          else await api.addSchedule(config, body);
          onDone();
        } catch (err) {
          const field = (err as { details?: { field?: string } }).details?.field;
          setError({ message: messageOf(err), ...(field ? { field } : {}) });
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Name" value={input.name} onChange={set('name')} required maxLength={100} />
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
        value={input.timezone}
        onChange={set('timezone')}
        required
        hint={`Like Europe/Berlin or UTC: summer time is followed. Yours is ${browserZone()}.`}
      />
      {input.kind === 'cron' ? (
        <>
          <Field
            label="Cron"
            value={input.cron}
            onChange={set('cron')}
            required
            spellCheck={false}
            hint={`minute hour day month weekday, in ${input.timezone.trim() || 'UTC'}: 0 3 * * 1-5 is 03:00 on weekdays. At most once a minute.`}
          />
          {at('cron') && <p className="bad-text">{at('cron')}</p>}
          <CronPreview cron={input.cron} timezone={input.timezone} />
        </>
      ) : (
        <Field
          label="At"
          type="datetime-local"
          value={input.onceAt}
          onChange={set('onceAt')}
          required
          hint={`In ${input.timezone.trim() || 'UTC'}.`}
        />
      )}
      <div className="field">
        <label htmlFor={ids.mode}>Mode</label>
        <select id={ids.mode} value={input.mode} onChange={set('mode')}>
          <option value="">as the configuration says</option>
          <option value="check">check (a skeleton run)</option>
          <option value="real">real</option>
        </select>
      </div>
      <Field
        label="Pinned commit"
        value={input.commit}
        onChange={set('commit')}
        pattern="[0-9a-f]{40}"
        spellCheck={false}
        hint="Empty: the newest commit of the configuration's branch when it fires."
      />
      {fields.length > 0 && (
        <fieldset>
          <legend>Inputs</legend>
          <p className="muted">Empty: the configuration's start value.</p>
          {fields.map((f) => (
            <Field
              key={f.name}
              label={f.name}
              value={inputs[f.name] ?? ''}
              placeholder={f.text}
              onChange={(e) => setInputs({ ...inputs, [f.name]: e.target.value })}
              hint={f.description}
            />
          ))}
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
      {error && (
        <p className="notice error" role="alert">
          {error.message}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Working…' : editing ? 'Save' : 'Add schedule'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
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
  mayManage,
  me,
}: {
  config: string;
  form?: LaunchForm;
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
              ) : (
                ', newest commit'
              )}
              {Object.keys(s.inputs).length > 0 && `, inputs ${Object.keys(s.inputs).join(', ')}`}
              <div className="muted">
                downtime: {s.missed === 'once' ? 'run once' : 'skip'}; still running:{' '}
                {s.overlap === 'skip' ? 'skip' : 'queue'}
              </div>
            </dd>
            <dt>Owner</dt>
            <dd>{s.owner.login}</dd>
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
              <button type="button" onClick={() => setOpen(s.id)}>
                Change
              </button>
              {(s.kind === 'cron' || s.enabled) && (
                <button
                  type="button"
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
