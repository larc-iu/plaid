// Shared chrome for the four project-import wizards (FLEx, CLDF, ELAN, the
// archive): the boxed notice every step uses, the grouped copyable warning list
// a long run produces, the banner that says a run is being continued, the
// project-name box, and what a run shows while it goes and when it stops.
//
// The wizards differ in what they read and what they ask; they do not differ in
// any of this, and when each screen wrote its own they drifted: one clamped the
// progress bar and three did not, and the same failure was reported in four
// wordings.

import { AlertTriangle, Square } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Input } from '@ui/components/ui/input';
import { Label } from '@ui/components/ui/label';
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

/**
 * The project this wizard is continuing an unfinished import into. `again`
 * says which file to choose again, in the words of the format.
 */
export const ResumeBanner = ({ name, again, onFinishAsIs }) => (
  <p className="mt-2 text-sm">
    Continuing the unfinished import into{' '}
    <span className="font-medium">{name ?? 'this project'}</span>. {again}{' '}
    <button
      type="button"
      onClick={onFinishAsIs}
      className="font-medium text-primary hover:underline"
    >
      Use the project as it is
    </button>
  </p>
);

/** The project's name. Fixed on a resume: the project already has one. */
export const ProjectNameField = ({ id, value, onChange, disabled, resuming }) => (
  <div className="rounded-lg border bg-card p-4">
    <Label className="mb-1 block text-sm font-medium" htmlFor={id}>
      Project name
    </Label>
    <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
    {resuming && (
      <p className="mt-1 text-xs text-muted-foreground">
        Continuing an import into this project. What it already holds is kept.
      </p>
    )}
  </div>
);

// The one formula. A phase that reports past its share of the bar (a corpus
// whose document count grew between runs) fills it rather than overflowing it.
const barWidth = (pct) => Math.min(100, Math.max(0, Math.round(pct ?? 0)));

/**
 * What a run shows: the bar and the step while it goes, and why it stopped
 * once it has. `children` sit between the two, which is where ELAN puts its
 * warning log.
 */
export const ImportRunPanel = ({ stage, runError, progress, onStop, children }) => (
  <>
    {runError && stage !== 'running' && (
      <Panel
        tone="error"
        icon={AlertTriangle}
        title={/cancel/i.test(runError) ? 'Import stopped' : 'Import failed'}
      >
        {!/cancel/i.test(runError) && <p className="mt-1 text-xs">{runError}</p>}
        <p className="mt-1 text-xs">Retry continues where it left off.</p>
      </Panel>
    )}
    {children}
    {stage === 'running' && (
      <div className="rounded-lg border bg-card p-4">
        <div className="mb-2 h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${barWidth(progress?.pct)}%` }}
          />
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">{progress?.label ?? 'Starting…'}</p>
          {onStop && (
            <Button variant="outline" size="sm" onClick={onStop}>
              <Square className="h-3.5 w-3.5" /> Stop
            </Button>
          )}
        </div>
      </div>
    )}
  </>
);
