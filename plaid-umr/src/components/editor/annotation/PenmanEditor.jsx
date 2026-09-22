import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@ui/components/ui/button';
import { useUnsavedDraft } from '@ui/hooks/useUnsavedDraft.js';
import { parsePenman } from '../../../domain/format/penman.js';

// The text mode of one sentence: its graph as PENMAN in a textarea, applied
// as one operation on Apply. A half-typed graph is not a state to keep, so
// nothing is written until then, and the parser's first complaint shows
// under the text as it is typed.
//
// `plan(text)` is the document's plan for the text: its `errors` are the
// checks the canvas makes (a variable taken, a new edge closing a cycle),
// shown like a parse error, and its `losses` what Apply would delete that the
// text cannot show, a node's anchor and document-level relations.
export function PenmanEditor({ initial, onApply, onCancel, plan, applying = false }) {
  const [text, setText] = useState(initial);
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
    if (initial === base) return;
    if (!dirty) setText(initial);
    setBase(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);
  const { problem, losses, rename } = useMemo(() => {
    const parsed = parsePenman(text);
    if (parsed.errors.length) return { problem: parsed.errors[0], losses: [], rename: [] };
    if (!parsed.root && text.trim()) {
      return { problem: { message: 'The text has no graph.' }, losses: [], rename: [] };
    }
    if (!plan || !dirty) return { problem: null, losses: [], rename: [] };
    const p = plan(text);
    return { problem: p.errors?.[0] || null, losses: p.losses || [], rename: p.rename || [] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, base]);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  // Tab indents by four, as the release files are indented.
  const onKeyDown = (e) => {
    e.stopPropagation();
    if (e.key === 'Tab') {
      e.preventDefault();
      const el = e.target;
      const { selectionStart: a, selectionEnd: b } = el;
      const next = `${text.slice(0, a)}    ${text.slice(b)}`;
      setText(next);
      requestAnimationFrame(() => el.setSelectionRange(a + 4, a + 4));
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
        <span className={`umr-penman-status${problem ? ' umr-penman-status--error' : ''}`}>
          {problem
            ? `${problem.message}${problem.line ? ` (line ${problem.line})` : ''}`
            : dirty
              ? `Changed. Apply writes it as one operation.${renameNote(rename)}${lossNote(losses)}`
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
      </div>
    </div>
  );
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
