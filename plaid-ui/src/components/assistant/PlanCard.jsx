import { Fragment, useMemo, useState } from 'react';
import {
  RotateCcw,
  Check,
  X,
  Loader2,
  ChevronDown,
  PenLine,
  UserCheck,
  FolderOpen,
} from 'lucide-react';
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
  // A plan that stopped partway: the rows written in full, how much was
  // written in the service's own count (a folded row counts each of its
  // changes), and whether the server went quiet on the rest.
  written,
  outcome,
  // An applied plan: what applying it said (a contributor's confirmation
  // accepted as their contribution, a change another one superseded), and
  // the rows it wrote nothing for.
  notes,
  unwritten,
  unknown = false,
  recordedAsHuman,
  // An out-of-date plan the reader discarded. It stays out of date (the
  // record of an approval that was refused) and offers nothing more.
  dismissed = false,
  interrupted,
  applying,
  canWrite,
  busy,
  onApprove,
  onDiscard,
  contributor = false,
  projectId,
  // The project the plan writes in, named when the conversation reads other
  // projects too, so a reader never takes a plan for one of theirs.
  planProject = null,
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
  // A later turn staged a plan of its own, which restates what still applies.
  const superseded = status === 'replaced';
  // The record says the plan was approved but the request that applied it is
  // gone, so whether the changes landed is unknown. The same buttons as an
  // undecided plan: applying again is safe, since the service refuses to
  // write the same plan twice.
  const lost = undecided && interrupted && !applying;
  // Stopped partway, and settled so: finishing it is a new plan.
  const partial = status === 'partial';
  const writtenRows = useMemo(() => new Set(partial ? written || [] : []), [partial, written]);
  const applied = status === 'applied';
  const unwrittenRows = useMemo(
    () => new Set(applied ? unwritten || [] : []),
    [applied, unwritten],
  );
  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2 text-sm',
        undecided && 'border-primary/40 bg-primary/5',
        status === 'applied' && 'border-success/40 bg-success/5',
        partial && 'border-warning/40 bg-warning/10',
        (status === 'discarded' || stale || superseded) && 'opacity-60',
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
        {superseded && (
          <Badge variant="outline" className="ml-auto">
            Replaced
          </Badge>
        )}
        {partial && (
          <Badge variant="outline" className="ml-auto">
            Partly applied
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
      {planProject && (
        <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
          <FolderOpen className="h-3 w-3 shrink-0" />
          <span className="min-w-0 truncate">
            In <bdi className="font-medium text-foreground">{planProject}</bdi>
          </span>
        </div>
      )}
      {lost && <p className="mt-2 text-xs text-muted-foreground">Applying did not finish.</p>}
      {partial && (
        <p className="mt-2 text-xs text-muted-foreground">
          {outcome}
          {unknown && ' The server did not answer for the rest.'}
        </p>
      )}
      {applied && notes?.length > 0 && (
        <div className="mt-2 text-xs text-muted-foreground" data-testid="apply-notes">
          {notes.map((n, i) => (
            <p key={i}>{n.charAt(0).toUpperCase() + n.slice(1)}.</p>
          ))}
        </div>
      )}
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
                  <ChangeRow
                    key={r.index}
                    row={r}
                    projectId={projectId}
                    adapter={adapter}
                    written={
                      partial
                        ? writtenRows.has(r.index)
                        : unwrittenRows.has(r.index)
                          ? false
                          : undefined
                    }
                    nothingWritten={unwrittenRows.has(r.index)}
                  />
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
      {stale && !dismissed && (
        <>
          <p className="mt-2 text-xs text-muted-foreground">
            Changed since this plan was made. Ask again to plan on the current version.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" disabled>
              <Check className="h-4 w-4" /> Approve and apply
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={onDiscard} disabled={busy}>
              <X className="h-4 w-4" /> Discard
            </Button>
          </div>
        </>
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
// On a plan that stopped partway, `written` says whether this change was
// written in full: a check if so, faded if not. On an applied plan,
// `nothingWritten` marks a change that wrote nothing (a contributor's
// confirmation of other contributors' work only), faded and said so.
const ChangeRow = ({ row, projectId, adapter, written, nothingWritten = false }) => {
  const place = adapter.changePlace(projectId, row.where);
  return (
    <tr
      className={cn('align-top', written === false && 'text-muted-foreground')}
      data-written={written === undefined ? undefined : String(written)}
    >
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
        {written && (
          <Check className="mr-1 inline h-3 w-3 align-[-2px] text-success" aria-label="Written" />
        )}
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
        {nothingWritten && <span className="ml-1.5">(nothing written)</span>}
      </td>
    </tr>
  );
};
