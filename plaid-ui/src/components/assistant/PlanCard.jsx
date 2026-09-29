import { Fragment, useMemo, useState } from 'react';
import { RotateCcw, Check, X, Loader2, ChevronDown, PenLine, UserCheck } from 'lucide-react';
import { Button } from '../ui/button.jsx';
import { Badge } from '../ui/badge.jsx';
import { cn } from '../../lib/utils.js';
import {
  collapseGroups,
  groupRows,
  planRows,
  ROWS_COLLAPSED,
  textRewrites,
  workReplaced,
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
  adapter,
  // Called when the card is expanded to show every change (research
  // telemetry's `plan.opened`, recorded by the chat around it).
  onOpen,
}) => {
  const allRows = useMemo(() => planRows(plan), [plan]);
  const groups = useMemo(
    () => groupRows(allRows, projectId, adapter),
    [allRows, projectId, adapter],
  );
  const [expanded, setExpanded] = useState(allRows.length <= ROWS_COLLAPSED);
  // Rewriting the text is not the same kind of act as annotating it: an
  // annotation can be set again, a transcription that has been retyped is
  // gone. The summary counts a text edit alongside a field value, which reads
  // as one more line of the same thing, so the card says it separately.
  const rewrites = useMemo(() => textRewrites(allRows), [allRows]);
  // Approving is the person's own act, so a plan may change what someone made
  // or accepted, and the card says how many of its changes do.
  const replaced = useMemo(() => workReplaced(allRows), [allRows]);
  const [asHuman, setAsHuman] = useState(!!recordedAsHuman);
  const humanId = `plan-human-${plan.id}`;
  const shown = expanded ? { groups, hidden: 0 } : collapseGroups(groups);
  const undecided = status === null;
  // Refused because what it changes has changed since: approving again would
  // only be refused again.
  const stale = status === 'stale';
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
        status === 'applied' && 'border-success/40 bg-success/5',
        (status === 'discarded' || stale) && 'opacity-60',
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
        {stale && (
          <Badge variant="outline" className="ml-auto">
            Out of date
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
      {lost && <p className="mt-2 text-xs text-muted-foreground">Applying did not finish.</p>}
      {rewrites > 0 && (
        <p className="mt-1.5 flex items-center gap-1.5 text-xs text-warning-foreground">
          <PenLine className="h-3.5 w-3.5 shrink-0" />
          {rewrites === 1
            ? `1 change rewrites ${adapter.textName}.`
            : `${rewrites} changes rewrite ${adapter.textName}.`}
        </p>
      )}
      {replaced > 0 && (
        <p className="mt-1.5 flex items-center gap-1.5 text-xs text-warning-foreground">
          <UserCheck className="h-3.5 w-3.5 shrink-0" />
          {replaced === 1
            ? '1 change replaces accepted work.'
            : `${replaced} changes replace accepted work.`}
        </p>
      )}
      {/* A size container, so a row's place can be held to a share of the
          card's own width: the panel is narrow and the tab is wide, and a
          fixed cap left the change itself one letter wide in the panel. */}
      <div className="mt-1 max-h-80 overflow-auto [container-type:inline-size]">
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
                      <a href={g.href} className="hover:underline">
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
                  <ChangeRow key={r.index} row={r} projectId={projectId} adapter={adapter} />
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {shown.hidden > 0 && (
        <button
          type="button"
          onClick={() => {
            setExpanded(true);
            onOpen?.();
          }}
          className="mt-1 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className="h-3 w-3" /> Show all {allRows.length}
        </button>
      )}
      {stale && (
        <div className="mt-2">
          <Button type="button" size="sm" disabled>
            <Check className="h-4 w-4" /> Approve and apply
          </Button>
        </div>
      )}
      {undecided && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
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
              className="ml-auto flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground"
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

// One change: where it lands, as a link into the editor, and what changes.
// The app says what that place is called and where it opens
// (`adapter.changePlace`); a change with no location shows its label alone.
//
// An ordinary anchor, no `target`. A row pointing into the document the panel
// is docked beside scrolls it in place, and every other row navigates the way
// any link does, which is what the delegated handler on the turn around this
// card arranges (Turn.jsx). Opening a new browser tab for every row was the
// panel's one link that behaved differently from the rest of the app, and it
// left the thread behind on a navigation the panel is built to survive.
const ChangeRow = ({ row, projectId, adapter }) => {
  const place = adapter.changePlace(projectId, row.where);
  return (
    <tr className="align-top">
      <td className="w-px whitespace-nowrap py-0.5 pr-4">
        <span className="inline-block max-w-[min(18rem,40cqi)] truncate align-bottom">
          {place && (
            <>
              {place.href ? (
                <a
                  href={place.href}
                  title={place.title}
                  className="font-medium text-foreground hover:underline"
                >
                  {place.name}
                </a>
              ) : (
                <span className="font-medium">{place.name}</span>
              )}
              {place.detail && <span className="ml-1.5 text-muted-foreground">{place.detail}</span>}
            </>
          )}
        </span>
      </td>
      <td className="py-0.5">
        {row.writesText && (
          <Badge
            variant="outline"
            className="mr-1.5 border-warning/40 px-1 py-0 align-[1px] text-[10px] font-medium text-warning-foreground"
          >
            Rewrite
          </Badge>
        )}
        {row.replacesWork > 0 && (
          <Badge
            variant="outline"
            className="mr-1.5 border-warning/40 px-1 py-0 align-[1px] text-[10px] font-medium text-warning-foreground"
          >
            Accepted
          </Badge>
        )}
        {row.change ?? row.label}
      </td>
    </tr>
  );
};
