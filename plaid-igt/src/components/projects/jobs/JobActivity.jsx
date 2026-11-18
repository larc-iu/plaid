import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button } from '@ui/components/ui/button';
import { ListHint, ListPager } from '@ui/components/shared/list-search.jsx';
import { SegmentedControl } from '@ui/components/shared/SegmentedControl.jsx';
import { TYPE } from '@ui/lib/typeScale.js';
import { fullTimestamp, timeAgo } from '@ui/lib/formatTime.js';
import { TALL_LIST_PAGE_SIZE, usePagedList } from '@ui/hooks/usePagedList.js';
import { isJobActive } from '@ui/domain/jobs.js';
import { APP_ROUTES } from '@/appRoutes.js';
import { JobWritten } from './JobReport.jsx';
import { PIECES_MAX } from './jobPieces.js';
import {
  pieceEndLines,
  pieceWrittenText,
  piecesFallShort,
  refusedText,
  skippedText,
} from './jobText.js';

/**
 * What a job has done so far (`jobs.piecesPage`, CONTRACT, added by LV): a row
 * per piece of its work as its worker summed it up once what the piece wrote
 * was known. Read again with each read of the job (`readAt`), so it fills in
 * while the job runs.
 *
 * While the job is active the list is newest first, on the shared pager at
 * TALL_LIST_PAGE_SIZE, read as far as the page in the address reaches (the
 * pager's next page on the last read one reads the next). Once it has ended,
 * every row is read at once (up to the route's cap), and the order is the
 * reader's, in the address (`?order=document`): newest first, or by document
 * in the job's order. A job whose worker kept none, and has ended, shows
 * nothing.
 *
 * The plan's row (the oldest) is not listed: the page says it (Plan). Where
 * the rows read do not reach it, it is read once, at the route's cap.
 */
const ORDERS = [
  { value: 'time', label: 'By time' },
  { value: 'document', label: 'By document' },
];

// The rows by document, in the job's order (a piece of all the documents
// first), each document's in the order they were done.
const byDocument = (rows, job) => {
  const at = new Map((job.documents || []).map((d, i) => [d.documentId, i]));
  const place = (r) => (r.piece.document ? (at.get(r.piece.document) ?? at.size) : -1);
  return [...rows].sort((a, b) => place(a) - place(b) || (a.seq < b.seq ? -1 : 1));
};

export const JobActivity = ({ job, projectId, pieces }) => {
  const [params, setParams] = useSearchParams();
  const active = isJobActive(job);
  const order = !active && params.get('order') === 'document' ? 'document' : 'time';
  const { page, rows } = pieces;
  const ordered = useMemo(
    () => (order === 'document' ? byDocument(rows, job) : rows),
    [order, rows, job],
  );
  const paged = usePagedList(ordered, { pageSize: TALL_LIST_PAGE_SIZE, urlParam: 'page' });
  if (!rows.length && !active) return null;
  // Not "Activity": the project's tab of that name is on the same screen.
  const heading = active ? 'Work so far' : 'Notes';
  const names = new Map((job.documents || []).map((d) => [d.documentId, d.name]));
  const states = new Map((job.documents || []).map((d) => [d.documentId, d.state]));
  // While the job runs, the next page past the rows read reads more, up to
  // the route's cap.
  const capped = !!page?.nextCursor && pieces.limit >= PIECES_MAX;
  const more =
    active && page?.nextCursor && !capped ? { load: async () => true, loading: false } : undefined;
  const setOrder = (value) =>
    setParams((prev) => {
      const out = new URLSearchParams(prev);
      if (value === 'document') out.set('order', value);
      else out.delete('order');
      out.delete('page');
      return out;
    });
  return (
    <section aria-label={heading}>
      {active && <h3 className={`${TYPE.card} mb-2 mt-8`}>{heading}</h3>}
      {page && !rows.length && (
        <p className="text-sm text-muted-foreground">Nothing finished yet.</p>
      )}
      {/* Each piece's note is the model's own text, as the summary is
          (RP4-4 finding 3): said once above the list. */}
      {rows.some((r) => r.piece.note) && (
        <p className="mb-2 text-sm text-muted-foreground">
          Notes written by the assistant, not checked against the counts.
        </p>
      )}
      {rows.length > 0 && (
        <div className="max-w-3xl rounded-md border bg-card">
          {!active && (
            <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
              <SegmentedControl label="Order" value={order} onChange={setOrder} options={ORDERS} />
            </div>
          )}
          <ListPager {...paged} onPage={paged.setPage} more={more} position="top" />
          <ul className="divide-y text-sm" data-testid="job-activity">
            {paged.pageItems.map(({ seq, piece }) => (
              <li key={seq} className="px-3 py-2" data-seq={seq}>
                <PieceRow
                  piece={piece}
                  projectId={projectId}
                  names={names}
                  states={states}
                  active={active}
                  findingsShown={reportHoldsFindings(job?.report)}
                />
              </li>
            ))}
          </ul>
          <ListPager {...paged} onPage={paged.setPage} more={more} position="bottom" />
        </div>
      )}
      {!active &&
        job.report &&
        page &&
        !page.nextCursor &&
        piecesFallShort(
          rows.map((r) => r.piece),
          job.documents,
        ) && (
          <p className="mt-2 text-sm" data-testid="job-activity-short">
            Some finished work is not listed here. The totals count all of it.
          </p>
        )}
      {capped && (
        <ListHint className="mt-2">
          Only the newest {PIECES_MAX.toLocaleString()} are listed.
        </ListHint>
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
  // A piece of a plan limited by a search names its sentences, which are no
  // run (the worker's `matching`, CONTRACT, added by SF).
  // Scattered sentences are named one by one (`sentences`, the rest past
  // the list `sentencesMore`, D12, REV-JR2-2).
  const range = piece.matching?.length
    ? `${piece.matching.join(', ')}, matching the plan’s search`
    : piece.sentences?.length
      ? piece.sentences.join(', ') +
        (piece.sentencesMore > 0 ? ` and ${piece.sentencesMore.toLocaleString()} more` : '')
      : piece.first &&
        (piece.first === piece.last ? piece.first : `${piece.first} to ${piece.last}`);
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

const PieceRow = ({ piece, projectId, names, states, active = false, findingsShown = false }) => {
  const skipped = piece.skipped || [];
  const refused = piece.refused || [];
  return (
    <>
      <div className="flex flex-wrap justify-between gap-x-4">
        <Where piece={piece} projectId={projectId} names={names} />
        <Ended piece={piece} />
      </div>
      <p>{pieceWrittenText(piece)}</p>
      {/* How a piece that did not finish ended, and what followed it
          (the worker's `failed`, `ended` and `rest`, BRIEF RW). */}
      {pieceEndLines(piece, states, active).map((line) => (
        <p key={line} data-testid="piece-end">
          {line}
        </p>
      ))}
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
