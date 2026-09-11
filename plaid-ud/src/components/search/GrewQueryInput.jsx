import { Search, TriangleAlert } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { cn } from '@ui/lib/utils';
import { highlightGrew } from './grewSyntax.js';
import { CodeEditor } from './CodeEditor.jsx';

// The query editor: a syntax-highlighted code box (CodeEditor + our tolerant
// Grew highlighter) + Run, plus an inline error panel. Parse/compile errors
// render here with a caret; server errors render as a message.

// The <pre> and the <textarea> inside CodeEditor must agree on every metric
// that decides where a glyph lands, so the metrics are one object passed to
// both rather than two sets of classes that could drift apart.
const EDITOR_STYLE = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 13,
  lineHeight: 1.5,
  minHeight: 72,
};

export const GrewQueryInput = ({ value, onChange, onRun, running, error, action = 'Search' }) => {
  const onKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      onRun();
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="max-h-[280px] overflow-auto rounded-md border bg-background">
        <CodeEditor
          value={value}
          onValueChange={onChange}
          highlight={highlightGrew}
          onKeyDown={onKeyDown}
          padding={10}
          textareaId="grew-query"
          placeholder={'pattern { X [upos=VERB]; Y [upos=NOUN]; X -[nsubj]-> Y }'}
          spellCheck={false}
          style={EDITOR_STYLE}
        />
      </div>
      <div>
        <Button onClick={onRun} disabled={running}>
          <Search className="h-4 w-4" />
          {running ? 'Running…' : action}
        </Button>
      </div>
      {error && <QueryError error={error} />}
    </div>
  );
};

function QueryError({ error }) {
  const isUnsupported = error.name === 'GrewUnsupportedError';
  const title =
    error.name === 'GrewParseError'
      ? `Syntax error${error.line ? ` (line ${error.line})` : ''}`
      : isUnsupported
        ? 'Unsupported feature'
        : error.name === 'GrewRuntimeError'
          ? `Rule error${error.line ? ` (line ${error.line})` : ''}`
          : 'Search failed';
  return (
    <div
      role="alert"
      className={cn(
        'flex gap-2 rounded-md border px-3 py-2 text-sm',
        isUnsupported
          ? 'border-amber-500/40 bg-amber-500/10 text-amber-900'
          : 'border-destructive/40 bg-destructive/10 text-destructive',
      )}
    >
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-medium">{title}</p>
        <p>{error.message}</p>
        {error.name === 'GrewParseError' && error.sourceLine != null && (
          // The caret sits under the offending column, so the block must not
          // wrap and must not collapse the padding spaces before it.
          <pre className="overflow-x-auto rounded bg-background/60 p-2 text-xs text-foreground">
            {error.sourceLine}
            {'\n'}
            {' '.repeat(Math.max(0, (error.col || 1) - 1))}^
          </pre>
        )}
      </div>
    </div>
  );
}
