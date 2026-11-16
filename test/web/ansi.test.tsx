// Ansible's colours in the run's terminal (AFS-96): codes to styled pieces, other escapes dropped.
import { describe, expect, it } from 'vitest';
import { parseAnsi } from '../../src/web/ansi';

const esc = String.fromCharCode(27);
const bel = String.fromCharCode(7);

describe('parseAnsi', () => {
  it('turns colour and bold codes into styled pieces, and a reset ends them', () => {
    const pieces = parseAnsi(
      `${esc}[1;31mfatal: [db-01]${esc}[0m: x\n${esc}[0;33mchanged${esc}[0m ${esc}[96mskip${esc}[39m`,
    );
    expect(pieces).toEqual([
      { text: 'fatal: [db-01]', style: { bold: true, fg: 1 } },
      { text: ': x\n', style: {} },
      { text: 'changed', style: { fg: 3 } },
      { text: ' ', style: {} },
      { text: 'skip', style: { fg: 14 } },
    ]);
  });

  it('drops escapes that are not colours, and 256-colour codes keep the first sixteen', () => {
    const text = `${esc}]0;title${bel}${esc}[2Kok ${esc}[38;5;2mgreen${esc}[38;5;200mpink${esc}[m end`;
    const pieces = parseAnsi(text);
    expect(pieces.map((p) => p.text).join('')).toBe('ok greenpink end');
    expect(pieces.find((p) => p.text === 'green')?.style.fg).toBe(2);
    expect(pieces.find((p) => p.text === ' end')?.style).toEqual({});
  });
});
