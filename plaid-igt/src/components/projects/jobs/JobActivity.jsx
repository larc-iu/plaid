import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@ui/components/ui/button';
import { ListHint } from '@ui/components/shared/list-search.jsx';
import { TYPE } from '@ui/lib/typeScale.js';
import { fullTimestamp, timeAgo } from '@ui/lib/formatTime.js';
import { TALL_LIST_PAGE_SIZE } from '@ui/hooks/usePagedList.js';
import { isJobActive } from '@ui/domain/jobs.js';
import { APP_ROUTES } from '@/appRoutes.js';
import { JobWritten } from './JobReport.jsx';
import { pieceWrittenText, piecesFallShort, refusedText, skippedText } from './jobText.js';

/**
 * What a job has done so far (`jobs.piecesPage`, CONTRACT, added by LV): a row
 * per piece of its work as its worker summed it up once what the piece wrote
 * was known, newest first. Read again with each read of the job (`readAt`), so
 * it fills in while the job runs. The newest TALL_LIST_PAGE_SIZE rows, and as
 * many more as Show more asks for. A job whose worker kept none, and has
 * ended, shows nothing.
 *
 * The plan's row (the oldest) is not listed: it goes to the page (`onPlan`),
 * whose Plan line, above the list, says it while the job runs (RP-9). Where
 * the first page does not reach it, it is read once, at the route's cap.
 */
// The most rows one read of the route answers (core's page cap).
const PIECES_MAX = 1000;

export const JobActivity = ({ client, job, projectId, readAt, onPlan = () => {} }) => {
  const [shown, setShown] = useState(TALL_LIST_PAGE_SIZE);
  const [page, setPage] = useState(null);
  // The job whose plan row was found, or looked for past the first page.
  const planFor = useRef(null);
  const onPlanRef = useRef(onPlan);
  onPlanRef.current = onPlan;
  useEffect(() => {
    let live = true;
    const planOf = (entries) => (entries || []).find((r) => r.piece?.plan)?.piece.plan ?? null;
    client.jobs
      .piecesPage(job.id, { limit: shown })
      .then(async (next) => {
        if (!live) return;
        setPage(next);
        if (planFor.current === job.id) return;
        let plan = planOf(next?.entries);
        if (!plan && next?.nextCursor) {
          planFor.current = job.id;
          plan = planOf((await client.jobs.piecesPage(job.id, { limit: PIECES_MAX }))?.entries);
        }
        if (plan && live) {
          planFor.current = job.id;
          onPlanRef.current(plan);
        }
      })
      // A read that fails keeps what the list shows: the next read of the job
      // asks again.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [client, job.id, shown, readAt]);

  const active = isJobActive(job);
  const rows = (page?.entries || []).filter((r) => !r.piece.plan);
  if (!rows.length && !active) return null;
  // Not "Activity": the project's tab of that name is on the same screen.
  const heading = active ? 'Work so far' : 'Work, in order';
  const names = new Map((job.documents || []).map((d) => [d.documentId, d.name]));
  return (
    <section aria-label={heading}>
      <h3 className={`${TYPE.card} mb-2 mt-8`}>{heading}</h3>
      {page && !rows.length && (
        <p className="text-sm text-muted-foreground">Nothing finished yet.</p>
      )}
      <ul className="max-w-3xl divide-y text-sm" data-testid="job-activity">
        {rows.map(({ seq, piece }) => (
          <li key={seq} className="py-2" data-seq={seq}>
            <PieceRow
              piece={piece}
              projectId={projectId}
              names={names}
              findingsShown={reportHoldsFindings(job?.report)}
            />
          </li>
        ))}
      </ul>
      {!active &&
        job.report &&
        page &&
        !page.nextCursor &&
        piecesFallShort(
          rows.map((r) => r.piece),
          job.documents,
        ) && (
          <p className="mt-2 text-sm" data-testid="job-activity-short">
            Some finished work is not listed here. The report below counts all of it.
          </p>
        )}
      {page?.nextCursor && shown >= PIECES_MAX && (
        <ListHint className="mt-2">
          Only the newest {PIECES_MAX.toLocaleString()} are listed.
        </ListHint>
      )}
      {page?.nextCursor && shown < PIECES_MAX && (
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={() => setShown((n) => Math.min(n + TALL_LIST_PAGE_SIZE, PIECES_MAX))}
        >
          Show more
        </Button>
      )}
    </section>
  );
};

// When the piece ended and its steps, as the chat counts and words a turn's
// steps (each tool call, "1 step", "3 steps").
const Ended = ({ piece }) => (
  <span className="whitespace-nowrap text-muted-foreground">
    {piece.endedAt && <span title={fullTimestamp(piece.endedAt)}>{timeAgo(piece.endedAt)}</span>}
    {piece.steps > 0 && ` · ${piece.steps} ${piece.steps === 1 ? 'step' : 'steps'}`}
  </span>
);

// A piece after a text edit, which takes the sentences the edit changed once
// more (the worker's `after_text`, CONTRACT, added by RPF3): the words the job
// added, for a job that fills only those, else the sentences after the edit.
const AFTER_TEXT_WORDS = { added: 'the words added', edited: 'after the text edit' };

// Where a piece worked: its document and sentences, a link into the grid at
// its first sentence, or the document for a piece of the whole document. The
// document's name as it is now: a document deleted since reads so.
const Where = ({ piece, projectId, names }) => {
  if (!piece.document) return <span className="font-medium">All documents</span>;
  const name = names.has(piece.document) ? names.get(piece.document) : piece.name;
  if (name === null || name === undefined) {
    return <span className="font-medium text-muted-foreground">Deleted document</span>;
  }
  const range =
    piece.first && (piece.first === piece.last ? piece.first : `${piece.first} to ${piece.last}`);
  const to = piece.firstId
    ? APP_ROUTES.sentence(projectId, piece.document, piece.firstId)
    : APP_ROUTES.document(projectId, piece.document);
  return (
    <Link className="font-medium underline" to={to}>
      <bdi>{name}</bdi>
      {range && ` ${range}`}
      {AFTER_TEXT_WORDS[piece.afterText] && `, ${AFTER_TEXT_WORDS[piece.afterText]}`}
    </Link>
  );
};

// A sentence of a skipped or refused list, linked into the grid where its
// document is still there.
const SentenceLink = ({ item, piece, projectId, names }) => {
  const documentId = item.documentId ?? item.document ?? piece.document;
  const there = documentId && item.sentenceId && names.get(documentId);
  return there ? (
    <Link className="underline" to={APP_ROUTES.sentence(projectId, documentId, item.sentenceId)}>
      {item.sentence}
    </Link>
  ) : (
    (item.sentence ?? '')
  );
};

// A fills-nothing piece's own findings, on its row, rendered as the report's
// are, opened on demand: the report holds only what fits its cap
// (REV-RPF2-4).
const PieceFindings = ({ findings }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1">
      <Button variant="outline" size="sm" onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide findings' : 'Show findings'}
      </Button>
      {open && (
        <div className="mt-2" data-testid="piece-findings">
          <JobWritten text={findings} />
        </div>
      )}
    </div>
  );
};

// Whether the report's findings, shown first on the page, hold every piece's
// whole: a piece's row then offers none of its own, which would be the same
// text again (RPF3-E). Rows keep theirs where the report cut some.
const reportHoldsFindings = (report) =>
  typeof report?.findings === 'string' && report.findings !== '' && !(report.findingsCut > 0);

const PieceRow = ({ piece, projectId, names, findingsShown = false }) => {
  const skipped = piece.skipped || [];
  const refused = piece.refused || [];
  return (
    <>
      <div className="flex flex-wrap justify-between gap-x-4">
        <Where piece={piece} projectId={projectId} names={names} />
        <Ended piece={piece} />
      </div>
      <p>{pieceWrittenText(piece)}</p>
      {(skipped.length > 0 || piece.skippedMore > 0) && (
        <>
          <p className="mt-1">Skipped:</p>
          <ul className="ml-4 list-disc">
            {skipped.map((s, i) => (
              <li key={`${s.sentenceId ?? s.sentence} ${i}`}>
                <SentenceLink item={s} piece={piece} projectId={projectId} names={names} />{' '}
                <span className="text-muted-foreground">{skippedText(s)}</span>
              </li>
            ))}
          </ul>
          {piece.skippedMore > 0 && (
            <p className="ml-4 text-muted-foreground">
              And {piece.skippedMore.toLocaleString()} more skipped.
            </p>
          )}
        </>
      )}
      {(refused.length > 0 || piece.refusedMore > 0) && (
        <>
          <p className="mt-1">Not done, refused:</p>
          <ul className="ml-4 list-disc">
            {refused.map((r, i) => (
              <li key={`${r.sentenceId ?? r.sentence} ${i}`}>
                <SentenceLink item={r} piece={piece} projectId={projectId} names={names} />{' '}
                <span className="text-muted-foreground">{refusedText(r.code)}</span>
              </li>
            ))}
          </ul>
          {piece.refusedMore > 0 && (
            <p className="ml-4 text-muted-foreground">
              And {piece.refusedMore.toLocaleString()} more refused.
            </p>
          )}
        </>
      )}
      {piece.note && (
        <div className="mt-1">
          <JobWritten text={piece.note} inline />
        </div>
      )}
      {piece.findings && !findingsShown && <PieceFindings findings={piece.findings} />}
      {/* A row the worker cut to fit core's cap (REV-LV-2). */}
      {piece.cut && <p className="text-muted-foreground">…</p>}
    </>
  );
};
