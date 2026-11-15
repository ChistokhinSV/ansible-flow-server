// The pages before anyone is signed in (AFS-64): a card in the middle of a calm picture of a
// flow. The page is public, so the picture is only shapes: no names, hosts, runs or numbers.
import { type ReactNode, useEffect, useState } from 'react';
import logo from '../../media/icons/svg/afs-icon-small.svg';
import { api, type User } from './api';
import { ProviderButtons } from './signin';
import { Field, Form, useLoad } from './ui';

/** Steps and wires, drawn once; it says nothing about this server. */
function Picture() {
  // [x, y, kind] of each step; pills are a flow's start and end.
  const steps: [number, number, string][] = [
    [370, 276, 'ok'],
    [370, 446, 'ok'],
    [680, 196, 'ok'],
    [720, 616, 'gate'],
    [1030, 126, ''],
    [1030, 336, ''],
    [1090, 716, ''],
    [70, 616, ''],
    [400, 736, ''],
    [720, 676, 'faded'],
  ];
  const wires: [string, string][] = [
    ['M150 170 C 260 170, 260 300, 370 300', ''],
    ['M150 170 C 260 170, 260 470, 370 470', ''],
    ['M520 300 C 600 300, 600 220, 680 220', ''],
    ['M520 470 C 620 470, 620 640, 720 640', 'wait'],
    ['M830 220 C 930 220, 930 150, 1030 150', ''],
    ['M830 220 C 930 220, 930 360, 1030 360', ''],
    ['M1180 150 C 1260 150, 1260 260, 1310 260', ''],
    ['M1180 360 C 1260 360, 1260 260, 1310 260', ''],
    ['M870 640 C 980 640, 980 740, 1090 740', 'dim'],
    ['M220 640 C 300 640, 300 760, 400 760', 'dim'],
    ['M550 760 C 640 760, 640 700, 720 700', 'dim'],
  ];
  const labels: [number, number, number, string][] = [
    [390, 295, 70, ''],
    [700, 215, 80, ''],
    [1050, 145, 60, ''],
    [740, 635, 70, 'gate'],
    [390, 465, 56, ''],
    [1050, 355, 76, ''],
  ];
  const ports: [number, number, string][] = [
    [520, 300, ''],
    [520, 470, ''],
    [830, 220, ''],
    [1180, 150, ''],
    [1180, 360, ''],
    [455, 300, 'soft'],
    [765, 220, 'soft'],
    [720, 640, 'wait'],
  ];
  return (
    <svg
      className="entry-picture"
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 1440 900"
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <pattern id="entry-dots" width="26" height="26" patternUnits="userSpaceOnUse">
          <circle className="dot" cx="1.2" cy="1.2" r="1.2" />
        </pattern>
        <radialGradient id="entry-fade" cx="50%" cy="50%" r="60%">
          <stop className="fade-in" offset="0%" />
          <stop className="fade-mid" offset="55%" />
          <stop className="fade-out" offset="100%" />
        </radialGradient>
      </defs>
      <rect width="1440" height="900" fill="url(#entry-dots)" />
      {wires.map(([d, kind]) => (
        <path key={d} className={`wire ${kind}`} d={d} />
      ))}
      <rect className="node pill" x="40" y="148" width="110" height="44" rx="22" />
      <rect className="node pill" x="1310" y="238" width="110" height="44" rx="22" />
      {steps.map(([x, y, kind]) => (
        <rect
          key={`${x}:${y}`}
          className={`node ${kind}`}
          x={x}
          y={y}
          width="150"
          height="48"
          rx="14"
        />
      ))}
      {labels.map(([x, y, w, kind]) => (
        <rect key={`${x}:${y}`} className={`lbl ${kind}`} x={x} y={y} width={w} height="8" rx="4" />
      ))}
      {ports.map(([x, y, kind]) => (
        <circle key={`${x}:${y}`} className={`port ${kind}`} cx={x} cy={y} r={kind ? 3 : 4} />
      ))}
      <rect width="1440" height="900" fill="url(#entry-fade)" />
    </svg>
  );
}

/** The frame of every page before sign-in: the picture, and a card in the middle. */
export function Entry({
  title,
  lead,
  wide,
  children,
}: {
  title?: string;
  lead?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    document.title = title?.includes('Ansible Flow Server')
      ? title
      : title
        ? `${title} · Ansible Flow Server`
        : 'Ansible Flow Server';
  }, [title]);
  return (
    <main className="entry" id="main">
      <Picture />
      <div className={wide ? 'entry-card wide' : 'entry-card'}>
        {title && (
          <div className="entry-title">
            <img src={logo} alt="" width="48" height="48" />
            <h1>{title}</h1>
            {lead && <p>{lead}</p>}
          </div>
        )}
        {children}
      </div>
    </main>
  );
}

export function Setup({ onDone }: { onDone: (user: User) => void }) {
  const [input, setInput] = useState({ code: '', login: '', name: '', password: '' });
  const set = (key: keyof typeof input) => (e: { target: { value: string } }) =>
    setInput((before) => ({ ...before, [key]: e.target.value }));
  return (
    <Entry
      wide
      title="Set up Ansible Flow Server"
      lead="This server has no user yet. Make its first administrator. The setup code is in the server's log, written when it started."
    >
      <Form submit="Make the administrator" onSubmit={async () => onDone(await api.setup(input))}>
        <Field label="Setup code" value={input.code} onChange={set('code')} required autoFocus />
        <Field
          label="Login"
          value={input.login}
          onChange={set('login')}
          required
          autoComplete="username"
        />
        <Field
          label="Name"
          value={input.name}
          onChange={set('name')}
          required
          autoComplete="name"
        />
        <Field
          label="Password"
          type="password"
          value={input.password}
          onChange={set('password')}
          required
          minLength={12}
          autoComplete="new-password"
          hint="At least 12 characters. A few words work well."
        />
      </Form>
    </Entry>
  );
}

export function SignIn({ onDone }: { onDone: (user: User) => void }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  // The organisation's sign-in first, when there is one (AFS-30); a password is the other way.
  const methods = useLoad(api.signInMethods, []);
  const providers = methods.data?.providers.length ?? 0;
  return (
    <Entry title="Sign in to Ansible Flow Server">
      <ProviderButtons methods={methods} />
      {providers > 0 && <div className="entry-or">or</div>}
      <Form
        submit="Sign in"
        quiet={providers > 0}
        onSubmit={async () => onDone(await api.signIn(login, password))}
      >
        <Field
          label="Login"
          value={login}
          onChange={(e) => setLogin(e.target.value)}
          required
          autoFocus={providers === 0}
          autoComplete="username"
        />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
        />
      </Form>
      <p className="entry-foot">No account yet? Ask your administrator.</p>
    </Entry>
  );
}
