// AFS-176 (ADR-0037): links to actions from NetBox and Zabbix. The page a link opens
// (`/a/<action>?<input>=<value>`): a confirm page when the link gives every value and they are
// right, else the action's short form with the link's values in and only what is missing to fill.
// Opening it never runs anything: Run is a POST from the page (and an action set to run on open
// makes that POST itself, and says so). And on the action's Settings: Copy link for NetBox and
// Zabbix, and signed links for systems with no person.
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import {
  ActionFormView,
  ActionRefused,
  actionAddress,
  linkWithValues,
  progressAddress,
  startAction,
  valueWords,
} from './actions';
import { type Action, type ActionLink, type ActionToken, ApiError, api } from './api';
import { ask } from './confirm';
import { Link, navigate } from './router';
import { Labelled, Loading, messageOf, PageHead, Time, useLoad } from './ui';

/** Where a link to an action opens. */
export const linkAddress = (id: string) => `/a/${encodeURIComponent(id)}`;

const SYSTEM_WORDS = { netbox: 'NetBox', zabbix: 'Zabbix' } as const;

/** What the link's reply says in words: where the result goes back. */
function replyWords(link: ActionLink): string | undefined {
  const system = link.form.replies;
  if (!system || !link.reply) return undefined;
  const [type, id] = link.reply.split(':');
  return system === 'netbox'
    ? `When it ends, NetBox gets a journal entry on ${type === 'dcim.device' ? 'the device' : type} ${id}.`
    : `When it ends, Zabbix gets a message on problem ${id}.`;
}

export function ActionLinkPage({ id }: { id: string }) {
  // The link's query, as it came: read once (the page's address does not change it).
  const [query] = useState(() => window.location.search);
  const link = useLoad(() => api.actionLink(id, query), [id, query]);
  const l = link.data;
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [change, setChange] = useState(false);
  const started = useRef(false);

  const run = async (onOpen: boolean) => {
    if (!l || busy) return;
    setBusy(true);
    setError(undefined);
    const from = { link: true as const, reply: l.reply };
    try {
      if (onOpen) {
        // AFS-207: the link's page gives its place in the history to the run it started, so
        // Back does not open it again; opened again all the same (from the history, a second
        // tab), the same values a moment ago open that run, not another.
        try {
          const done = await api.runAction(id, l.values, from);
          navigate(`${progressAddress(done.id)}?started=link`, { replace: true });
        } catch (e) {
          const twin = e instanceof ApiError && e.code === 'duplicate' ? e.details.run : undefined;
          if (!twin) throw e;
          navigate(`${progressAddress(twin.id)}?started=twin`, { replace: true });
        }
      } else navigate(await startAction(id, l.values, from));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  // An action set to run on open: the page starts it (once), never the GET that opened it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the link is read
  useEffect(() => {
    if (l?.ready && l.form.runOnOpen && !started.current) {
      started.current = true;
      void run(true);
    }
  }, [l]);

  if (link.error) return <ActionRefused message={link.error} />;
  if (!l) return <Loading state={link} />;
  const f = l.form;
  const head = <PageHead title={f.title} lead={f.summary} help="actions.md" />;
  if (l.refused)
    return (
      <>
        {head}
        <section className="panel action-form" aria-label="This link">
          <p className="notice error" role="alert">
            {l.refused}
          </p>
          <div className="actions">
            <Link to={actionAddress(id)} className="button">
              Open the action's form
            </Link>
            <Link to="/actions">All actions</Link>
          </div>
          <p className="muted small">Questions about it: ask {f.ask.join(' or ')}.</p>
        </section>
      </>
    );
  const back = replyWords(l);
  const notes = (
    <>
      {back && <p className="muted">{back}</p>}
      {l.replyNote && <p className="notice warn">{l.replyNote}</p>}
    </>
  );
  if (!l.ready || change || f.blocked) {
    const problems = Object.fromEntries(l.problems.map((p) => [p.field, p.message]));
    // Only what is missing or not right is asked; what the link gave right is listed.
    const only = change
      ? undefined
      : f.fields
          .filter(
            (x) => !l.given.includes(x.name) || problems[x.name] || l.missing.includes(x.name),
          )
          .map((x) => x.name);
    return (
      <>
        {head}
        {!change && !f.blocked && (
          <p className="notice info" role="status">
            {/* AFS-207: a wrong value is said as one, not as one missing. */}
            {l.problems.length
              ? `The link gives ${l.problems.length === 1 ? 'a value' : 'values'} this action does not take: pick again below, then Run.`
              : l.missing.length && l.given.length
                ? 'The link gives some of what this action needs: fill in the rest, then Run.'
                : 'The link gives no values: fill in what it asks, then Run.'}
          </p>
        )}
        {notes}
        <ActionFormView
          id={id}
          form={f}
          start={l.values}
          {...(only ? { only } : {})}
          problems={problems}
          from={{ link: true, reply: l.reply }}
        />
      </>
    );
  }
  return (
    <>
      {head}
      <section className="panel action-form confirm-link" aria-label="Run this action">
        <p className="lead" role="status" aria-live="polite">
          {f.runOnOpen
            ? busy
              ? 'Starting it now…'
              : 'This action runs as its link opens.'
            : 'The link gives everything it needs. Check the values, then Run.'}
        </p>
        <dl className="facts">
          {f.fields.map((x) => (
            <div key={x.name}>
              <dt>{x.label}</dt>
              <dd>
                {l.values[x.name] ? (
                  valueWords(x, l.values[x.name] ?? '', l.counts?.[x.name])
                ) : (
                  <span className="muted">(none)</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
        <div className="happens">
          <h2>What will happen</h2>
          <ul>
            {f.happens.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </div>
        {notes}
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="button" className="primary" disabled={busy} onClick={() => run(false)}>
            {busy ? 'Starting…' : 'Run'}
          </button>
          {f.fields.length > 0 && (
            <button type="button" disabled={busy} onClick={() => setChange(true)}>
              Change the values
            </button>
          )}
          <Link to="/actions">Not now</Link>
        </div>
        {f.ask.length > 0 && (
          <p className="muted small">Questions about it: ask {f.ask.join(' or ')}.</p>
        )}
      </section>
    </>
  );
}

// --- on the action's Settings: Copy link for NetBox and Zabbix, and signed links

/** NetBox attributes of a device a link can carry, as Jinja on the custom link's `object`. */
const NETBOX_PICKS: { value: string; words: string }[] = [
  { value: 'object.name', words: 'its name' },
  { value: 'object.primary_ip4.address.ip', words: 'its primary IPv4 address' },
  { value: 'object.primary_ip.address.ip', words: 'its primary IP address' },
  { value: 'object.site.name', words: 'its site' },
  { value: 'object.role.name', words: 'its role' },
  { value: 'object.serial', words: 'its serial number' },
  { value: 'object.tenant.name', words: 'its tenant' },
  { value: 'object.id', words: 'its NetBox id' },
];
/** Zabbix macros a URL script resolves for a host, or for a problem's host. */
const ZABBIX_PICKS: { value: string; words: string }[] = [
  { value: '{HOST.HOST}', words: 'the host name' },
  { value: '{HOST.NAME}', words: 'the visible name' },
  { value: '{HOST.IP}', words: 'the IP address' },
  { value: '{HOST.DNS}', words: 'the DNS name' },
  { value: '{HOST.CONN}', words: 'the address it is reached on' },
  { value: '{EVENT.ID}', words: 'the problem id (problem menu only)' },
  { value: '{MANUALINPUT}', words: 'what the person types when they open it' },
];

/**
 * A NetBox attribute as Jinja in a custom link's URL, URL-encoded: `{{ object.name|urlencode }}`.
 * A deeper one is guarded by its first part, so a device without an address gives an empty value
 * (the form then asks for it), not an error page.
 */
export function netboxValue(attribute: string): string {
  const parts = attribute.split('.');
  const value = `${attribute}|string|urlencode`;
  return parts.length > 2
    ? `{{ ${value} if ${parts.slice(0, 2).join('.')} else '' }}`
    : `{{ ${value} }}`;
}

export interface LinkTemplate {
  /** The action link with placeholders. */
  url: string;
  /** The body for NetBox's POST /api/extras/custom-links/. */
  netbox?: Record<string, unknown>;
  /** The JSON-RPC call to Zabbix's script.create. */
  zabbix?: Record<string, unknown>;
}

/** The link of an action for a system, with a placeholder per input (empty: left out). */
export function linkTemplate(
  origin: string,
  action: Pick<Action, 'id' | 'title' | 'reply'>,
  system: 'netbox' | 'zabbix',
  picks: Record<string, string>,
  options: { objectType?: string; scope?: 'host' | 'problem' } = {},
): LinkTemplate {
  const params = Object.entries(picks)
    .filter(([, v]) => v.trim())
    .map(([name, v]) =>
      system === 'netbox'
        ? `${encodeURIComponent(name)}=${v.includes('{{') ? v : netboxValue(v)}`
        : `${encodeURIComponent(name)}=${v}`,
    );
  const objectType = options.objectType?.trim() || 'dcim.device';
  if (action.reply?.system === 'netbox' && system === 'netbox')
    params.push(`_reply=${objectType}:{{ object.id }}`);
  if (action.reply?.system === 'zabbix' && system === 'zabbix' && options.scope === 'problem')
    params.push('_reply=event:{EVENT.ID}');
  const url = `${origin}${linkAddress(action.id)}${params.length ? `?${params.join('&')}` : ''}`;
  if (system === 'netbox')
    return {
      url,
      netbox: {
        name: action.title.slice(0, 100),
        object_types: [objectType],
        link_text: action.title,
        link_url: url,
        new_window: true,
        button_class: 'blue',
        group_name: 'Ansible Flow Server',
      },
    };
  return {
    url,
    zabbix: {
      jsonrpc: '2.0',
      method: 'script.create',
      params: {
        name: action.title,
        type: 6,
        scope: options.scope === 'problem' ? 4 : 2,
        url,
        new_window: 1,
        menu_path: 'Ansible Flow Server',
        ...(Object.values(picks).some((v) => v.includes('{MANUALINPUT}'))
          ? {
              manualinput: 1,
              manualinput_prompt: 'Value for the action',
              manualinput_validator_type: 0,
              manualinput_validator: '.+',
            }
          : {}),
      },
      id: 1,
    },
  };
}

/** A block of text to copy (a JSON body, a command). */
function CopyBlock({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-block">
      <pre>{text}</pre>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 3000);
          } catch {
            setCopied(false);
          }
        }}
        aria-label={`Copy ${label}`}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/**
 * AFS-201: the full link with values filled in, to hand to a person (mail, chat, a ticket). The
 * values are checked as the form checks them (the link's own check, which runs nothing), and the
 * page says what the person will see: the confirm page, or the short form with what is left.
 */
export function ValueLink({ action }: { action: Action }) {
  const id = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const url = linkWithValues(window.location.origin, action.id, values);
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
  const [seen, setSeen] = useState<{ query: string; link?: ActionLink; error?: string }>();
  useEffect(() => {
    let gone = false;
    // Asked once typing rests, not at every key.
    const timer = setTimeout(() => {
      api.actionLink(action.id, query).then(
        (link) => !gone && setSeen({ query, link }),
        (e) => !gone && setSeen({ query, error: messageOf(e) }),
      );
    }, 400);
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [action.id, query]);
  const now = seen?.query === query ? seen : undefined;
  const problems = Object.fromEntries((now?.link?.problems ?? []).map((p) => [p.field, p.message]));
  const label = (name: string) => action.asked.find((a) => a.name === name)?.label ?? name;
  const sees = !now
    ? 'Checking the values…'
    : now.error
      ? now.error
      : now.link?.refused
        ? now.link.refused
        : now.link?.problems.length
          ? 'A value is not right: the person would be asked to pick again.'
          : now.link?.ready
            ? action.runOnOpen
              ? 'It runs as the link opens: the page starts it and says so.'
              : 'A confirm page with these values and Run.'
            : `The short form, asking only for ${(now.link?.missing.length
                ? now.link.missing
                : action.asked.filter((a) => !values[a.name]?.trim()).map((a) => a.name)
              )
                .map(label)
                .join(', ')}.`;
  return (
    <>
      <h3 id={`${id}-values`}>A link with values</h3>
      <p className="muted small">
        Fill in what the link gives; what you leave empty, the person who opens it fills in. It
        opens the action with their own access: opening it runs nothing by itself.
      </p>
      <fieldset className="choices copy-link" aria-labelledby={`${id}-values`}>
        <legend className="sr-only">Values in the link</legend>
        {action.asked.length === 0 && (
          <p className="muted">It asks nothing: the link opens its Run page.</p>
        )}
        {action.asked.map((a) => (
          <Labelled
            key={a.name}
            label={a.label}
            {...(a.help ? { hint: a.help } : {})}
            {...(problems[a.name] ? { problem: problems[a.name] } : {})}
          >
            {(props) =>
              a.choices?.length ? (
                <select
                  {...props}
                  value={values[a.name] ?? ''}
                  onChange={(e) => setValues({ ...values, [a.name]: e.target.value })}
                >
                  <option value="">(left for the person)</option>
                  {a.choices.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  {...props}
                  value={values[a.name] ?? ''}
                  spellCheck={false}
                  maxLength={2000}
                  placeholder="(left for the person)"
                  onChange={(e) => setValues({ ...values, [a.name]: e.target.value })}
                />
              )
            }
          </Labelled>
        ))}
        <p data-link-sees>
          <strong>The person sees:</strong> {sees}
        </p>
        <CopyBlock text={url} label="the link with values" />
      </fieldset>
    </>
  );
}

/** AFS-176: Copy link for NetBox / Zabbix, and the action's signed links. */
/**
 * AFS-207: what a link carries into each asked input by default: the object's name into the host
 * list (the first, when the flow's types are not known), its site into an input named so, its
 * address into one named so; the rest is left for the person.
 */
export function linkDefaults(
  asked: readonly { name: string; label: string }[],
  types: Record<string, string | undefined>,
  to: 'netbox' | 'zabbix',
): Record<string, string> {
  const hostLists = asked.filter((a) => types[a.name] === 'host_list');
  const named = hostLists[0]?.name ?? (Object.keys(types).length ? undefined : asked[0]?.name);
  const netbox = to === 'netbox';
  return Object.fromEntries(
    asked.map((a) => {
      const words = `${a.name} ${a.label}`;
      if (a.name === named) return [a.name, netbox ? 'object.name' : '{HOST.HOST}'];
      if (hostLists.some((h) => h.name === a.name)) return [a.name, ''];
      if (netbox && /site/i.test(words)) return [a.name, 'object.site.name'];
      if (/\bip\b|ip_|_ip|addr/i.test(words))
        return [a.name, netbox ? 'object.primary_ip4.address.ip' : '{HOST.IP}'];
      return [a.name, ''];
    }),
  );
}

/** AFS-207: an address only this machine reaches: a link made with it works nowhere else. */
const localOnly = (host: string) =>
  /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)$/i.test(host) || host.endsWith('.localhost');

export function ActionLinks({
  config,
  action,
  tokens,
  onChange,
  types = {},
}: {
  config: string;
  action: Action;
  tokens: ActionToken[];
  onChange(): void;
  /** AFS-207: the flow's input types by name: a host list gets the object's name. */
  types?: Record<string, string | undefined>;
}) {
  const id = useId();
  const [system, setSystem] = useState<'netbox' | 'zabbix'>('netbox');
  const [scope, setScope] = useState<'host' | 'problem'>('host');
  const [objectType, setObjectType] = useState('dcim.device');
  const defaults = (to: 'netbox' | 'zabbix') => linkDefaults(action.asked, types, to);
  const [picks, setPicks] = useState<Record<string, string>>(() => defaults('netbox'));
  const origin = window.location.origin;
  const made = linkTemplate(origin, action, system, picks, { objectType, scope });
  const choices = system === 'netbox' ? NETBOX_PICKS : ZABBIX_PICKS;

  return (
    <>
      <h3 id={`${id}-links`}>Links from NetBox and Zabbix</h3>
      <p className="muted small">
        A link opens this action with values from the object it is on: the person confirms, or fills
        in what the link did not give, and runs it with their own access.{' '}
        <a
          href="/help/guide/actions.md#links-from-netbox-and-zabbix"
          target="_blank"
          rel="noopener"
        >
          How to set it up
        </a>
      </p>
      <fieldset className="choices copy-link" aria-labelledby={`${id}-links`}>
        <legend>Copy link for</legend>
        <div className="inline-choices">
          {(['netbox', 'zabbix'] as const).map((s) => (
            <label key={s} className="inline">
              <input
                type="radio"
                name={`${id}-system`}
                checked={system === s}
                onChange={() => {
                  setSystem(s);
                  setPicks(defaults(s));
                }}
              />
              {SYSTEM_WORDS[s]}
            </label>
          ))}
        </div>
        {system === 'netbox' ? (
          <Labelled
            label="On objects of type"
            hint="dcim.device for devices; virtualization.virtualmachine for virtual machines."
          >
            {(props) => (
              <input
                {...props}
                spellCheck={false}
                value={objectType}
                onChange={(e) => setObjectType(e.target.value)}
              />
            )}
          </Labelled>
        ) : (
          <div className="field">
            <label htmlFor={`${id}-scope`}>In the menu of</label>
            <select
              id={`${id}-scope`}
              value={scope}
              onChange={(e) => setScope(e.target.value as 'host' | 'problem')}
            >
              <option value="host">a host</option>
              <option value="problem">a problem (its event id can take the result back)</option>
            </select>
          </div>
        )}
        {action.asked.map((a) => (
          <div key={a.name} className="field">
            <label htmlFor={`${id}-${a.name}`}>{a.label} from</label>
            <select
              id={`${id}-${a.name}`}
              value={picks[a.name] ?? ''}
              onChange={(e) => setPicks({ ...picks, [a.name]: e.target.value })}
            >
              <option value="">(left out: the person fills it in)</option>
              {choices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.words} ({c.value})
                </option>
              ))}
            </select>
          </div>
        ))}
        <h4>The link</h4>
        {localOnly(window.location.hostname) && (
          <p className="notice warn">
            This page is open at {window.location.host}, which only this machine reaches: a link
            made here does not open from {SYSTEM_WORDS[system]}. Open the server at the address its
            users reach, then copy the link.
          </p>
        )}
        <CopyBlock text={made.url} label="the link" />
        {made.netbox && (
          <>
            <h4>NetBox custom link</h4>
            <p className="muted small">
              In NetBox: Customization › Custom Links › Add, with these values; or POST this to{' '}
              <code>/api/extras/custom-links/</code> with a NetBox token.
            </p>
            <CopyBlock text={JSON.stringify(made.netbox, null, 2)} label="the NetBox custom link" />
          </>
        )}
        {made.zabbix && (
          <>
            <h4>Zabbix script</h4>
            <p className="muted small">
              In Zabbix: Alerts › Scripts › Create script, type URL; or send this to{' '}
              <code>/api_jsonrpc.php</code> with a Zabbix API token.
            </p>
            <CopyBlock text={JSON.stringify(made.zabbix, null, 2)} label="the Zabbix script" />
          </>
        )}
      </fieldset>
      <SignedLinks config={config} action={action} tokens={tokens} onChange={onChange} />
    </>
  );
}

/** Signed links: a token per system with no person, made and revoked here, shown once. */
function SignedLinks({
  config,
  action,
  tokens,
  onChange,
}: {
  config: string;
  action: Action;
  tokens: ActionToken[];
  onChange(): void;
}) {
  const id = useId();
  const [name, setName] = useState('');
  const [made, setMade] = useState<string>();
  const [note, setNote] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState(false);
  const make = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setNote(undefined);
    try {
      const got = await api.createActionToken(config, name.trim());
      setMade(got.token);
      setName('');
      onChange();
    } catch (e) {
      setNote({ ok: false, text: messageOf(e) });
    } finally {
      setBusy(false);
    }
  };
  const inputs = Object.fromEntries(action.asked.map((a) => [a.name, `<${a.label}>`]));
  const example = (token: string) =>
    [
      `curl -X POST ${window.location.origin}/api/v1/actions/${action.id}/run \\`,
      `  -H 'Authorization: Bearer ${token}' \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  -d '${JSON.stringify({ inputs, ...(action.reply?.system === 'zabbix' ? { reply: 'event:{EVENT.ID}' } : {}) })}'`,
    ].join('\n');
  return (
    <>
      <h3 id={`${id}-signed`}>Signed links</h3>
      <p className="muted small">
        For a system that starts runs with no person (a Zabbix action, a NetBox webhook): a token
        that runs this action only, as you, with the inputs it asks. It goes in the Authorization
        header of a POST, never in a link. Every run with it is in the audit log.
      </p>
      {made && (
        <div className="notice ok" role="status">
          <p>The token, shown this once: keep it in the system that uses it.</p>
          <CopyBlock text={made} label="the token" />
          <p className="small">A call with it:</p>
          <CopyBlock text={example(made)} label="the call" />
        </div>
      )}
      {tokens.length === 0 ? (
        <p className="muted">No signed links.</p>
      ) : (
        <ul className="list plain">
          {tokens.map((t) => (
            <li key={t.id} className="row-line">
              <span>
                {t.name} <span className="muted">…{t.hint}</span>{' '}
                <span className="muted small">
                  by {t.createdBy},{' '}
                  {t.lastUsedAt ? (
                    <>
                      last used <Time at={t.lastUsedAt} />
                    </>
                  ) : (
                    'not used yet'
                  )}
                </span>
              </span>
              <button
                type="button"
                className="danger"
                aria-label={`Revoke the signed link ${t.name}`}
                onClick={async () => {
                  if (
                    !(await ask(`Revoke the signed link "${t.name}"? It stops at once.`, {
                      yes: 'Revoke',
                      danger: true,
                    }))
                  )
                    return;
                  try {
                    await api.revokeActionToken(config, t.id);
                    // AFS-207: a revoked token is not left on the page.
                    setMade(undefined);
                    setNote({ ok: true, text: `Revoked ${t.name}.` });
                  } catch (e) {
                    setNote({ ok: false, text: messageOf(e) });
                  }
                  onChange();
                }}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="form" onSubmit={make}>
        <Labelled label="Name" hint="What uses it: Zabbix action on F5 problems.">
          {(props) => (
            <input
              {...props}
              maxLength={100}
              value={name}
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Labelled>
        {note && (
          <p className={`notice ${note.ok ? 'ok' : 'error'}`} role={note.ok ? 'status' : 'alert'}>
            {note.text}
          </p>
        )}
        <div className="actions">
          <button type="submit" disabled={busy || !name.trim()}>
            {busy ? 'Making…' : 'Make a signed link'}
          </button>
        </div>
      </form>
    </>
  );
}
