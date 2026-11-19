// AFS-155: the user guide's Markdown (docs/guide) as the pages show it. Only what the guide uses:
// headings, paragraphs, lists (nested), code blocks, tables, quotes, rules; code, bold, italics,
// links and pictures in a line. Made of React elements, never HTML from the text.
import { Fragment, type ReactNode } from 'react';
import { Scroll } from './ui';

export type Block =
  | { t: 'heading'; level: number; text: string }
  | { t: 'para'; text: string }
  | { t: 'code'; lang: string; text: string }
  | { t: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { t: 'quote'; blocks: Block[] }
  | {
      t: 'table';
      head: string[];
      align: ('left' | 'right' | 'center' | undefined)[];
      rows: string[][];
    }
  | { t: 'rule' };

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+-]*)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)/;
const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const indentOf = (line: string) => line.length - line.trimStart().length;
const blank = (line: string | undefined) => line === undefined || line.trim() === '';

/** The cells of a table row: split at `|` outside code, `\|` is a bar in the cell. */
function cells(line: string): string[] {
  const out: string[] = [];
  let cell = '';
  let code = false;
  const row = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === '\\' && row[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (c === '`') {
      code = !code;
      cell += c;
    } else if (c === '|' && !code) {
      out.push(cell.trim());
      cell = '';
    } else cell += c;
  }
  out.push(cell.trim());
  return out;
}

/** A line that starts a block of its own, ending a paragraph before it. */
const startsBlock = (line: string) =>
  FENCE.test(line) ||
  HEADING.test(line) ||
  RULE.test(line) ||
  /^\s*>/.test(line) ||
  (ITEM.test(line) && indentOf(line) < 4);

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (blank(line)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const [, indent = '', mark = '```', lang = ''] = fence;
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] as string).trim().startsWith(mark)) {
        const l = lines[i] as string;
        body.push(l.slice(Math.min(indent.length, indentOf(l))));
        i++;
      }
      i++;
      blocks.push({ t: 'code', lang, text: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ t: 'heading', level: (heading[1] as string).length, text: heading[2] ?? '' });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ t: 'rule' });
      i++;
      continue;
    }
    if (line.trimStart().startsWith('|') && SEPARATOR.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      const align = cells(lines[i + 1] as string).map((c) =>
        c.startsWith(':') && c.endsWith(':')
          ? ('center' as const)
          : c.endsWith(':')
            ? ('right' as const)
            : c.startsWith(':')
              ? ('left' as const)
              : undefined,
      );
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] as string).trimStart().startsWith('|'))
        rows.push(cells(lines[i++] as string));
      blocks.push({ t: 'table', head, align, rows });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] as string))
        body.push((lines[i++] as string).replace(/^\s*>\s?/, ''));
      blocks.push({ t: 'quote', blocks: parseBlocks(body.join('\n')) });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      const base = indentOf(line);
      const ordered = /\d/.test(item[2] as string);
      const items: string[][] = [];
      while (i < lines.length) {
        const l = lines[i] as string;
        const m = ITEM.exec(l);
        if (m && indentOf(l) === base && /\d/.test(m[2] as string) === ordered) {
          // An item: its text starts after the marker; its other lines are indented under it.
          items.push([l.slice((m[0] as string).length)]);
          i++;
          continue;
        }
        if (blank(l)) {
          // A blank line goes on with the list when what follows is indented under it, or is the
          // next item.
          let j = i + 1;
          while (j < lines.length && blank(lines[j])) j++;
          const next = lines[j];
          const nextItem = next !== undefined && ITEM.exec(next);
          if (
            next !== undefined &&
            (indentOf(next) > base || (nextItem && indentOf(next) === base))
          ) {
            items.at(-1)?.push('');
            i++;
            continue;
          }
          break;
        }
        if (indentOf(l) > base) {
          // Indented under the item: dedented by as much as the item's text is.
          items.at(-1)?.push(l.slice(Math.min(indentOf(l), base + 2 + (ordered ? 1 : 0))));
          i++;
          continue;
        }
        break;
      }
      blocks.push({
        t: 'list',
        ordered,
        start: ordered ? Number.parseInt(item[2] as string, 10) : 1,
        items: items.map((lines) => parseBlocks(lines.join('\n'))),
      });
      continue;
    }
    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && !blank(lines[i]) && !startsBlock(lines[i] as string))
      para.push((lines[i++] as string).trim());
    blocks.push({ t: 'para', text: para.join('\n') });
  }
  return blocks;
}

/** A heading's anchor as GitHub makes it: `## Editing flows in the pages` -> editing-flows-in-the-pages. */
export function slug(text: string): string {
  return plain(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

/** The words of a line of Markdown, without its marks. */
export function plain(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|`|\*)/g, '');
}

export interface Render {
  /** A link: where it leads, as written, and its words. */
  link: (href: string, children: ReactNode, key: string) => ReactNode;
  /** The address a picture is served at, from its path as written. */
  image: (src: string) => string | undefined;
}

const INLINE =
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|!\[([^\]]*)\]\(\s*([^)\s]+)\s*\)|\[((?:[^[\]]|\[[^\]]*\])*)\]\(\s*([^)\s]+)\s*\)|\*\*([\s\S]+?)\*\*|\*([^*\s][^*]*?)\*|<(https?:\/\/[^>\s]+)>/g;

export function inline(text: string, render: Render, key = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const k = `${key}.${n++}`;
    if (m.index > at) out.push(text.slice(at, m.index).replace(/\n/g, ' '));
    at = m.index + m[0].length;
    if (m[1]) out.push(<code key={k}>{(m[2] as string).replace(/\n/g, ' ')}</code>);
    else if (m[4] !== undefined) {
      const src = render.image(m[4]);
      out.push(src ? <img key={k} src={src} alt={m[3] ?? ''} loading="lazy" /> : (m[3] ?? ''));
    } else if (m[6] !== undefined) out.push(render.link(m[6], inline(m[5] ?? '', render, k), k));
    else if (m[7] !== undefined) out.push(<strong key={k}>{inline(m[7], render, k)}</strong>);
    else if (m[8] !== undefined) out.push(<em key={k}>{inline(m[8], render, k)}</em>);
    else if (m[9] !== undefined) out.push(render.link(m[9], m[9], k));
  }
  if (at < text.length) out.push(text.slice(at).replace(/\n/g, ' '));
  return out;
}

/** The blocks as React elements; headings carry their anchors (`ids` keeps them unique). */
export function renderBlocks(
  blocks: Block[],
  render: Render,
  key = 'b',
  ids = new Map<string, number>(),
): ReactNode[] {
  return blocks.map((b, n) => {
    const k = `${key}.${n}`;
    switch (b.t) {
      case 'heading': {
        const base = slug(b.text);
        const seen = ids.get(base) ?? 0;
        ids.set(base, seen + 1);
        const id = seen ? `${base}-${seen}` : base;
        const Tag = `h${Math.min(6, b.level)}` as 'h2';
        return (
          <Tag key={k} id={id}>
            {inline(b.text, render, k)}
          </Tag>
        );
      }
      case 'para':
        return <p key={k}>{inline(b.text, render, k)}</p>;
      case 'code':
        return (
          <pre key={k} className="guide-code">
            <code data-lang={b.lang || undefined}>{b.text}</code>
          </pre>
        );
      case 'rule':
        return <hr key={k} />;
      case 'quote':
        return <blockquote key={k}>{renderBlocks(b.blocks, render, k, ids)}</blockquote>;
      case 'table':
        return (
          <Scroll key={k}>
            <table>
              <thead>
                <tr>
                  {b.head.map((h, c) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: a column is its place
                    <th key={c} style={b.align[c] ? { textAlign: b.align[c] } : undefined}>
                      {inline(h, render, `${k}.h${c}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((row, r) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a row is its place
                  <tr key={r}>
                    {row.map((cell, c) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: a column is its place
                      <td key={c} style={b.align[c] ? { textAlign: b.align[c] } : undefined}>
                        {inline(cell, render, `${k}.${r}.${c}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
        );
      case 'list': {
        const items = b.items.map((item, i) => {
          // An item of one paragraph is its words, without a paragraph's space around them.
          const [first, ...rest] = item;
          const ik = `${k}.${i}`;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: an item is its place
            <li key={i}>
              {first?.t === 'para' ? (
                <Fragment>
                  {inline(first.text, render, ik)}
                  {renderBlocks(rest, render, ik, ids)}
                </Fragment>
              ) : (
                renderBlocks(item, render, ik, ids)
              )}
            </li>
          );
        });
        return b.ordered ? (
          <ol key={k} start={b.start === 1 ? undefined : b.start}>
            {items}
          </ol>
        ) : (
          <ul key={k}>{items}</ul>
        );
      }
    }
    return null;
  });
}
