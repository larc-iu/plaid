import { Fragment, useMemo, useState } from 'react';
import { RotateCcw, Check, X, Loader2, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  ROWS_COLLAPSED,
  changeHref,
  changeRef,
  changeTitle,
  collapseGroups,
  groupRows,
  planRows,
} from './planChanges.js';

// A proposed change set, row by row, with its apply controls.
// A proposed plan: what it does in one line, every change as a row under the
// document or lexicon it lands in, and the decision. Once settled it stays in
// the transcript as a record.
export const PlanCard = ({
  plan,
  status,
  recordedAsHuman,
  interrupted,
  applying,
  canWrite,
  busy,
  onApprove,
  onDiscard,
  contributor = false,
  projectId,
}) => {
  const allRows = useMemo(() => planRows(plan), [plan]);
  const groups = useMemo(() => groupRows(allRows, projectId), [allRows, projectId]);
  const [expanded, setExpanded] = useState(allRows.length <= ROWS_COLLAPSED);
  const [asHuman, setAsHuman] = useState(!!recordedAsHuman);
  const humanId = `plan-human-${plan.id}`;
  const shown = expanded ? { groups, hidden: 0 } : collapseGroups(groups);
  const undecided = status === null;
  // The record says the plan was approved but the request that applied it is
  // gone, so whether the changes landed is unknown. The same buttons as an
  // undecided plan: applying again is safe, since the service refuses to
  // write the same plan twice.
  const lost = undecided && interrupted && !applying;
  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2 text-sm',
        undecided && 'border-primary/40 bg-primary/5',
        status === 'applied' && 'border-green-600/40 bg-green-600/5',
        status === 'discarded' && 'opacity-60',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Proposed changes</span>
        <span className="text-muted-foreground">{plan.summary}</span>
        {status === 'applied' && (
          <Badge variant="secondary" className="ml-auto">
            <Check className="mr-1 h-3 w-3" /> Applied
          </Badge>
        )}
        {status === 'discarded' && (
          <Badge variant="outline" className="ml-auto">
            Discarded
          </Badge>
        )}
        {applying && (
          <Badge variant="secondary" className="ml-auto">
            <Loader2 className="mr-1 h-3 w-3 animate-spin" /> Applying…
          </Badge>
        )}
        {lost && (
          <Badge variant="outline" className="ml-auto">
            Not finished
          </Badge>
        )}
      </div>
      {lost && (
        <p className="mt-2 text-xs text-muted-foreground">
          Applying did not finish. Applying again is safe: a plan that was already applied is not
          written twice.
        </p>
      )}
      <div className="mt-1 max-h-80 overflow-auto">
        <table className="w-full border-collapse text-xs leading-5">
          <tbody>
            {shown.groups.map((g) => (
              <Fragment key={g.key}>
                <tr>
                  <th
                    colSpan={2}
                    scope="colgroup"
                    className="pt-2 text-left font-medium text-foreground"
                  >
                    {g.href ? (
                      <a
                        href={g.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline"
                      >
                        {g.title}
                      </a>
                    ) : (
                      g.title
                    )}
                    <span className="ml-1.5 font-normal text-muted-foreground">
                      {g.rows.length}
                    </span>
                  </th>
                </tr>
                {g.rows.map((r) => (
                  <ChangeRow key={r.index} row={r} projectId={projectId} />
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {shown.hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-1 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className="h-3 w-3" /> Show all {allRows.length}
        </button>
      )}
      {undecided && (
        <div className="mt-2 flex items-center gap-2">
          {canWrite ? (
            <Button type="button" size="sm" onClick={() => onApprove({ asHuman })} disabled={busy}>
              {lost ? (
                <>
                  <RotateCcw className="h-4 w-4" /> Apply again
                </>
              ) : (
                <>
                  <Check className="h-4 w-4" /> Approve and apply
                </>
              )}
            </Button>
          ) : (
            <span className="text-muted-foreground">Applying needs write access.</span>
          )}
          <Button type="button" size="sm" variant="outline" onClick={onDiscard} disabled={busy}>
            <X className="h-4 w-4" /> Discard
          </Button>
          {canWrite && !contributor && (
            <label
              htmlFor={humanId}
              className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
              title="By default the changes are recorded as made by the assistant and verified by you. Tick this to record them as if you had made them yourself (no machine provenance)."
            >
              <input
                id={humanId}
                type="checkbox"
                className="h-3.5 w-3.5"
                checked={asHuman}
                disabled={busy}
                onChange={(e) => setAsHuman(e.target.checked)}
              />
              Record as human-made
            </label>
          )}
        </div>
      )}
    </div>
  );
};

// One change: where it lands, as a link into the editor (the word itself,
// with its reference; a sentence by number; a lexicon entry by form), and
// what changes.
export const ChangeRow = ({ row, projectId }) => {
  const w = row.where;
  const href = changeHref(projectId, w);
  const title = changeTitle(w);
  let place = null;
  if (w?.kind === 'token') {
    const isSentence = !w.word;
    place = (
      <>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          title={title}
          className="font-medium text-foreground hover:underline"
        >
          {isSentence ? `Sentence ${w.sentence}` : w.surface}
        </a>
        <span className="ml-1.5 text-muted-foreground">
          {isSentence ? w.surface : changeRef(w)}
        </span>
      </>
    );
  } else if (w?.kind === 'entry') {
    place = href ? (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={title}
        className="font-medium text-foreground hover:underline"
      >
        {w.form}
      </a>
    ) : (
      <span className="font-medium">{w.form}</span>
    );
  }
  return (
    <tr className="align-top">
      <td className="w-px whitespace-nowrap py-0.5 pr-4">
        <span className="inline-block max-w-[18rem] truncate align-bottom">{place}</span>
      </td>
      <td className="py-0.5">{row.change ?? row.label}</td>
    </tr>
  );
};
