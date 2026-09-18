import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@ui/components/ui/button';
import { parsePenman } from '../../../domain/format/penman.js';

// The text mode of one sentence: its graph as PENMAN in a textarea, applied
// as one operation on Apply. A half-typed graph is not a state to keep, so
// nothing is written until then, and the parser's first complaint shows
// under the text as it is typed.
export function PenmanEditor({ initial, onApply, onCancel, applying = false }) {
  const [text, setText] = useState(initial);
  const ref = useRef(null);
  const dirty = text !== initial;
  const problem = useMemo(() => {
    const parsed = parsePenman(text);
    if (parsed.errors.length) return parsed.errors[0];
    if (!parsed.root && text.trim()) return { message: 'The text has no graph.' };
    return null;
  }, [text]);

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
              ? 'Changed. Apply writes it as one operation.'
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
