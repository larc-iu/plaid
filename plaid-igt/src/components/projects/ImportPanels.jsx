// Shared chrome for the import wizards: the boxed notice every step uses, and
// the grouped, copyable warning list a long run produces.

import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { notifySuccess } from '@/utils/feedback';

export const Panel = ({ tone = 'muted', icon: Icon, title, children }) => {
  const tones = {
    muted: 'border-border bg-muted/40',
    warn: 'border-amber-500/40 bg-amber-500/10',
    error: 'border-destructive/40 bg-destructive/10',
  };
  return (
    <div className={`flex items-start gap-2 rounded-md border p-3 text-sm ${tones[tone]}`}>
      {Icon && <Icon className="mt-0.5 h-4 w-4 shrink-0" />}
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium">{title}</p>}
        {children}
      </div>
    </div>
  );
};

// Every warning the import raises, in the order it raised them, grouped by the
// document it came from. On screen while the run is still going, because on a
// long corpus a problem is worth seeing before the end, and scrollable because
// a real corpus can raise hundreds.
// Past this many, the list is a wall rather than information, and rendering one
// node per warning starts to cost. A corpus that capitalises its word tier
// systematically raises one per utterance, so thousands is a real shape.
const LOG_RENDER_LIMIT = 200;

export const WarningLog = ({ log }) => {
  const groups = [];
  for (const entry of log.slice(0, LOG_RENDER_LIMIT)) {
    const last = groups[groups.length - 1];
    if (last && last.document === entry.document) last.items.push(entry.text);
    else groups.push({ document: entry.document, items: [entry.text] });
  }
  const hidden = log.length - Math.min(log.length, LOG_RENDER_LIMIT);
  // Copy takes the whole log, not just the part on screen: the cap is about
  // what is readable, not about what was recorded.
  const asText = () => log.map((e) => `${e.document ?? 'Corpus'}\t${e.text}`).join('\n');
  return (
    <Panel
      tone="warn"
      icon={AlertTriangle}
      title={`${log.length} warning${log.length === 1 ? '' : 's'}`}
    >
      <div className="mt-2 max-h-64 overflow-y-auto rounded border bg-background/60 p-2">
        {groups.map((g, gi) => (
          <div key={gi} className={gi ? 'mt-2' : ''}>
            <p className="text-xs font-medium">{g.document ?? 'The corpus as a whole'}</p>
            <ul className="list-inside list-disc text-xs text-muted-foreground">
              {g.items.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          </div>
        ))}
        {hidden > 0 && (
          <p className="mt-2 text-xs font-medium">and {hidden} more, which Copy includes.</p>
        )}
      </div>
      <Button
        variant="outline"
        size="sm"
        className="mt-2"
        onClick={() => {
          navigator.clipboard?.writeText(asText());
          notifySuccess('Warnings copied.', 'Import');
        }}
      >
        Copy
      </Button>
    </Panel>
  );
};
