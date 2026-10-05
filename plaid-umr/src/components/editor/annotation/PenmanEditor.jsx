import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@ui/components/ui/button';
import { useUnsavedDraft } from '@ui/hooks/useUnsavedDraft.js';
import { chordText } from '@ui/lib/chords.js';
import { parsePenman } from '../../../domain/format/penman.js';

// The text mode of one sentence: its graph as PENMAN in a textarea, applied
// as one operation on Apply. Every node of the sentence is in the text: the
// parts its root does not reach follow the root's graph as graphs of their
// own. A half-typed graph is not a state to keep, so
// nothing is written until then, and the parser's first complaint shows
// under the text as it is typed.
//
// `plan(text)` is the document's plan for the text: its `errors` are the
// checks the canvas makes (a variable taken, a new edge closing a cycle),
// shown like a parse error, and its `losses` what Apply would delete that the
// text cannot show, a node's anchor and document-level relations. `typed` is
// a text to open with in place of the stored graph, one typed before and not
// applied. `dirtyRef.current` says whether the text differs from the stored
// graph, for a control outside the editor that closes it.
export function PenmanEditor({
  initial,
  typed = null,
  onApply,
  onCancel,
  plan,
  applying = false,
  dirtyRef = null,
}) {
  const [text, setText] = useState(typed ?? initial);
  // What the text is compared against. When the stored graph changes under an
  // untouched editor (another writer, a failed apply's reload), the text
  // follows it; once typed in, the text stays and only the base moves.
  const [base, setBase] = useState(initial);
  const ref = useRef(null);
  const dirty = text !== base;
  // Typed and not applied. Every way out of this screen asks first: the tab
  // strip, a link, the browser's Back, a reload. One editor per sentence, so
  // several can be typed in at once and the question counts them.
  useUnsavedDraft(dirty ? 'The graph you have typed' : null, 'graphs');
  useEffect(() => {
    if (!dirtyRef) return undefined;
    dirtyRef.current = dirty;
    return () => {
      dirtyRef.current = false;
    };
  }, [dirty, dirtyRef]);
  useEffect(() => {
    if (initial === base) return;
    if (!dirty) setText(initial);
    setBase(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);
  const { problem, losses, rename, concepts } = useMemo(() => {
    const none = { losses: [], rename: [], concepts: [] };
    const parsed = parsePenman(text, { several: true });
    if (parsed.errors.length) return { ...none, problem: parsed.errors[0] };
    if (!parsed.root && text.trim()) {
      return { ...none, problem: { message: 'The text has no graph.' } };
    }
    if (!plan || !dirty) return { ...none, problem: null };
    const p = plan(text);
    return {
      problem: p.errors?.[0] || null,
      losses: p.losses || [],
      rename: p.rename || [],
      concepts: p.concept || [],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, base]);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  // Tab indents by four, as the release files are indented, and Shift+Tab
  // takes up to four back off. A selection over several lines is indented
  // or outdented line by line. Escape and Ctrl+Enter are the keys out.
  const onKeyDown = (e) => {
    e.stopPropagation();
    if (e.key === 'Tab') {
      e.preventDefault();
      const el = e.target;
      const { selectionStart: a, selectionEnd: b } = el;
      const edit = shiftLines(text, a, b, e.shiftKey ? -1 : 1);
      if (!edit) return;
      setText(edit.text);
      requestAnimationFrame(() => el.setSelectionRange(edit.start, edit.end));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel(dirty);
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (!problem && dirty) onApply(text);
    }
  };

  const lines = text.split('\n').length;
  return (
    <div className="umr-penman">
      <div className="umr-penman-body">
        <pre className="umr-penman-gutter" aria-hidden="true">
          {Array.from({ length: lines }, (_, i) => i + 1).join('\n')}
        </pre>
        <textarea
          ref={ref}
          className="umr-penman-text"
          value={text}
          rows={Math.max(6, lines + 1)}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="PENMAN"
        />
      </div>
      <div className="umr-penman-foot">
        <span
          role="status"
          className={`umr-penman-status${problem ? ' umr-penman-status--error' : ''}`}
        >
          {problem
            ? `${problem.message}${problem.line ? ` (line ${problem.line})` : ''}`
            : dirty
              ? `Changed. Apply saves it.${renameNote(rename)}${conceptNote(concepts)}${lossNote(losses)}`
              : 'As stored.'}
        </span>
        <Button type="button" variant="outline" size="sm" onClick={() => onCancel(dirty)}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!!problem || !dirty || applying}
          onClick={() => onApply(text)}
        >
          Apply
        </Button>
        <span className="text-xs text-muted-foreground">
          {chordText('Mod+Enter', { words: true })}
        </span>
      </div>
    </div>
  );
}

const INDENT = '    ';

/**
 * Tab (`step` 1) or Shift+Tab (-1) at a selection from `a` to `b`: the new
 * text and selection, or null when nothing changes. Tab at a bare caret puts
 * four spaces there. With a selection, and always for Shift+Tab, each line
 * the selection touches is indented by four or has up to four leading
 * spaces taken off, so no selected text is ever replaced.
 */
function shiftLines(text, a, b, step) {
  const lineStart = text.lastIndexOf('\n', a - 1) + 1;
  // A selection ending at the start of a line leaves that line alone.
  const end = b > a && text[b - 1] === '\n' ? b - 1 : b;
  const block = text.slice(lineStart, end);
  if (step > 0 && a === b) {
    const next = `${text.slice(0, a)}${INDENT}${text.slice(b)}`;
    return { text: next, start: a + INDENT.length, end: a + INDENT.length };
  }
  const lines = block.split('\n');
  const taken = lines.map((line) => (step > 0 ? 0 : /^ {0,4}/.exec(line)[0].length));
  const shifted = lines.map((line, i) => (step > 0 ? INDENT + line : line.slice(taken[i])));
  const total = taken.reduce((x, y) => x + y, 0);
  if (step < 0 && !total) return null;
  const next = `${text.slice(0, lineStart)}${shifted.join('\n')}${text.slice(end)}`;
  if (step > 0) {
    return {
      text: next,
      start: a + INDENT.length,
      end: b + INDENT.length * lines.length,
    };
  }
  const start = Math.max(lineStart, a - taken[0]);
  return { text: next, start, end: Math.max(start, b - total) };
}

// What Apply deletes that the text does not show, as a sentence: " It deletes
// s1p with its anchor and 1 document-level relation."
// A variable typed over keeps its node, so the line says which name changes
// rather than leaving the annotator to wonder what became of the old one.
function renameNote(rename) {
  if (!rename.length) return '';
  const one = (r) => `${r.from} is now ${r.to}`;
  return ` ${rename.map(one).join(', ')}.`;
}

// Every concept the text changes, by variable: " s9x changes from sleep-01
// to cat, s9y from cat to sleep-01." Nodes are matched by variable, so two
// names exchanged in the text exchange the concepts, and the node keeps its
// words and document-level relations. The line says so rather than guessing
// that two renames were meant.
function conceptNote(concepts) {
  if (!concepts.length) return '';
  const [first, ...rest] = concepts;
  const parts = [
    `${first.var} changes from ${first.from} to ${first.concept}`,
    ...rest.map((c) => `${c.var} from ${c.from} to ${c.concept}`),
  ];
  return ` ${parts.join(', ')}.`;
}

function lossNote(losses) {
  if (!losses.length) return '';
  const one = ({ var: v, anchored, relations }) => {
    const what = [
      anchored && 'its anchor',
      relations && `${relations} document-level relation${relations === 1 ? '' : 's'}`,
    ].filter(Boolean);
    return `${v} with ${what.join(' and ')}`;
  };
  return ` It deletes ${losses.map(one).join(', ')}.`;
}
