// Ansible's colours in the run page's terminal (AFS-96): the output keeps the terminal's colour codes
// (SGR: bold, dim, underline, the 16 colours, reset); they become spans with classes, so the theme
// picks the actual colours. Other escape sequences are dropped.
import type { ReactNode } from 'react';

interface Style {
  fg?: number;
  bg?: number;
  bold?: boolean;
  dim?: boolean;
  underline?: boolean;
}

export interface Piece {
  text: string;
  style: Style;
}

// CSI ... final byte, or OSC ... BEL/ST, or a lone ESC with one more character.
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape codes are control characters
const ESCAPE = /\u001b(?:\[([0-9;?]*)([@-~])|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

function apply(style: Style, params: string): Style {
  const codes = params === '' ? [0] : params.split(';').map((p) => Number(p) || 0);
  let s = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i] ?? 0;
    if (c === 0) s = {};
    else if (c === 1) s.bold = true;
    else if (c === 2) s.dim = true;
    else if (c === 22) {
      s.bold = false;
      s.dim = false;
    } else if (c === 4) s.underline = true;
    else if (c === 24) s.underline = false;
    else if (c >= 30 && c <= 37) s.fg = c - 30;
    else if (c >= 90 && c <= 97) s.fg = c - 90 + 8;
    else if (c === 39) s.fg = undefined;
    else if (c >= 40 && c <= 47) s.bg = c - 40;
    else if (c >= 100 && c <= 107) s.bg = c - 100 + 8;
    else if (c === 49) s.bg = undefined;
    else if (c === 38 || c === 48) {
      // 256 colours (5;n) or true colour (2;r;g;b): the first 16 map to ours, the rest are left.
      const mode = codes[i + 1];
      if (mode === 5) {
        const n = codes[i + 2] ?? 0;
        if (n < 16) s[c === 38 ? 'fg' : 'bg'] = n;
        i += 2;
      } else if (mode === 2) i += 4;
    }
  }
  return s;
}

/** The text cut where its style changes, each piece with its style; escape codes removed. */
export function parseAnsi(text: string): Piece[] {
  const out: Piece[] = [];
  let style: Style = {};
  let at = 0;
  const push = (t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && last.style === style) last.text += t;
    else out.push({ text: t, style });
  };
  for (const m of text.matchAll(ESCAPE)) {
    push(text.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[2] === 'm') style = apply(style, m[1] ?? '');
  }
  push(text.slice(at));
  return out;
}

const classOf = (s: Style) =>
  [
    s.fg !== undefined && `ansi-fg-${s.fg}`,
    s.bg !== undefined && `ansi-bg-${s.bg}`,
    s.bold && 'ansi-bold',
    s.dim && 'ansi-dim',
    s.underline && 'ansi-underline',
  ]
    .filter(Boolean)
    .join(' ');

/** Terminal output with its colours, as React nodes. */
export function AnsiText({ text }: { text: string }): ReactNode {
  return parseAnsi(text).map((p, i) => {
    const cls = classOf(p.style);
    if (!cls) return p.text;
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: pieces have no identity but their place
      <span key={i} className={cls}>
        {p.text}
      </span>
    );
  });
}
