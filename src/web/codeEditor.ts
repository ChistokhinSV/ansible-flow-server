// AFS-78: the text editor of the Files page: CodeMirror 6 with the highlighting a file's name
// asks for (YAML, Jinja2 templates, ini/cfg, Python, Markdown, JSON, shell). Loaded only when a
// file is opened, so the other pages do not carry it.
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { yaml } from '@codemirror/lang-yaml';
import {
  bracketMatching,
  defaultHighlightStyle,
  HighlightStyle,
  type LanguageSupport,
  StreamLanguage,
  syntaxHighlighting,
} from '@codemirror/language';
import { jinja2 } from '@codemirror/legacy-modes/mode/jinja2';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { EditorState, type Extension } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';

/** The language of a file by its name; plain text when none fits. */
export function languageOf(path: string): Extension[] {
  const name = path.toLowerCase();
  const lang = (l: LanguageSupport | StreamLanguage<unknown>) => [l];
  if (/\.(ya?ml)$/.test(name) || /(^|\/)(group_vars|host_vars)\/[^/.]+$/.test(name))
    return lang(yaml());
  if (/\.(j2|jinja2?)$/.test(name)) return lang(StreamLanguage.define(jinja2));
  if (/\.(ini|cfg|conf|properties)$/.test(name) || /(^|\/)(hosts|inventory)$/.test(name))
    return lang(StreamLanguage.define(properties));
  if (/\.py$/.test(name)) return lang(python());
  if (/\.(md|markdown)$/.test(name)) return lang(markdown());
  if (/\.json$/.test(name)) return lang(json());
  if (/\.(sh|bash)$/.test(name)) return lang(StreamLanguage.define(shell));
  return [];
}

/** Colours for the dark theme; the light one is CodeMirror's own. */
const darkHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword], color: '#c586c0' },
  { tag: [tags.string, tags.special(tags.string)], color: '#ce9178' },
  { tag: [tags.number, tags.bool, tags.null], color: '#b5cea8' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: '#7ca668' },
  {
    tag: [tags.propertyName, tags.attributeName, tags.definition(tags.propertyName)],
    color: '#9cdcfe',
  },
  { tag: [tags.variableName, tags.name], color: '#9cdcfe' },
  { tag: [tags.heading], color: '#5ca1db', fontWeight: 'bold' },
  { tag: [tags.meta, tags.bracket, tags.punctuation], color: '#d4d4d4' },
  { tag: [tags.typeName, tags.className], color: '#4ec9b0' },
]);

const look = EditorView.theme({
  '&': {
    border: '1px solid var(--input-border)',
    borderRadius: '4px',
    backgroundColor: 'var(--input-bg)',
    color: 'var(--fg)',
    fontSize: '13px',
  },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace',
    minHeight: '16rem',
    // AFS-94: a file fills the window under the page's head, not a part of it.
    maxHeight: 'max(24rem, calc(100vh - 17rem))',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--panel)',
    color: 'var(--muted)',
    borderRight: '1px solid var(--border)',
  },
  '&.cm-focused': { outline: '2px solid var(--accent)', outlineOffset: '-1px' },
  '.cm-activeLine, .cm-activeLineGutter': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 8%, transparent)',
  },
});

export interface Editor {
  text(): string;
  /** AFS-140: puts the cursor in the text. */
  focus(): void;
  destroy(): void;
}

/** An editor in `parent`; `onChange` hears each change; read-only when `editable` is false. */
export function createEditor(
  parent: HTMLElement,
  options: {
    path: string;
    text: string;
    editable: boolean;
    dark: boolean;
    label: string;
    onChange?: (text: string) => void;
    /** AFS-183: the line (1-based) to put the cursor on and show in the middle. */
    line?: number;
  },
): Editor {
  // In a shadow root: CodeMirror styles it with constructed style sheets there, which the
  // pages' Content-Security-Policy (style-src 'self') allows, where a <style> element is refused.
  // The page's colour variables reach inside.
  const shadow = parent.shadowRoot ?? parent.attachShadow({ mode: 'open' });
  const host = document.createElement('div');
  shadow.replaceChildren(host);
  const view = new EditorView({
    parent: host,
    root: shadow,
    state: EditorState.create({
      doc: options.text,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        drawSelection(),
        bracketMatching(),
        syntaxHighlighting(options.dark ? darkHighlight : defaultHighlightStyle, {
          fallback: true,
        }),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorState.readOnly.of(!options.editable),
        EditorView.editable.of(options.editable),
        // AFS-140: a labelled text box for assistive technology, also inside the shadow root.
        EditorView.contentAttributes.of({
          'aria-label': options.label,
          role: 'textbox',
          'aria-multiline': 'true',
          ...(options.editable ? {} : { 'aria-readonly': 'true' }),
        }),
        EditorView.lineWrapping,
        look,
        ...languageOf(options.path),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) options.onChange?.(update.state.doc.toString());
        }),
      ],
    }),
  });
  if (options.line && options.line > 0) {
    // AFS-183: where a value is defined: that line, with the cursor on it (its line is marked).
    const at = view.state.doc.line(Math.min(Math.floor(options.line), view.state.doc.lines));
    view.dispatch({
      selection: { anchor: at.from },
      effects: EditorView.scrollIntoView(at.from, { y: 'center' }),
    });
  }
  return {
    text: () => view.state.doc.toString(),
    focus: () => view.focus(),
    destroy: () => {
      view.destroy();
      host.remove();
    },
  };
}
