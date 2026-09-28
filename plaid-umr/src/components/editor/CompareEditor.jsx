import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Scale } from 'lucide-react';
import { Label } from '@ui/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ui/components/ui/select';
import { ServiceRunDialog } from '@ui/components/services/ServiceRunDialog.jsx';
import { ServiceMethodRow } from '@ui/components/services/ServiceMethodRow.jsx';
import { ServiceRunButton } from '@ui/components/services/ServiceRunButton.jsx';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { canEditProject } from '@ui/domain/permissions.js';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useDocumentEditor } from '@ui/hooks/useDocumentEditor.js';
import { UmrDocument } from '../../domain/UmrDocument.js';
import {
  conceptsDiffer,
  markVariables,
  percent,
  readAdjudication,
  scoreRows,
  SENTENCE_SCORE_LABELS,
  sentenceMarks,
  sentenceReport,
} from '../../domain/adjudication.js';
import { humanizeError } from '../../utils/feedback.jsx';

// The document scored against another document of the same text: two
// annotators' copies, or a draft against a corrected one. The score is
// AnCast's, computed by the Compare service, and the report it leaves on the
// document is what this tab shows: the scores, and sentence by sentence the
// two graphs with the disagreements marked, a node with no counterpart and a
// node paired with one of another concept.

// The two marks, one class each, shared by the graphs and the legend. Each
// has an outline at 3:1 or more on the page, and they differ in pattern as
// well as hue: dashed where the other graph has nothing, solid where it has
// another concept. Never amber, the contributor's colour.
const MARK_CLASS = {
  missing: 'rounded bg-sky-100 px-0.5 text-sky-950 outline-dashed outline-1 outline-sky-700',
  differs: 'rounded bg-rose-100 px-0.5 text-rose-950 outline outline-1 outline-rose-700',
};
export const CompareEditor = () => {
  const { projectId, documentId, doc, project, services, writeLockHeld } = useDocumentEditor();
  const { getClient, user } = useAuth();
  const client = getClient();
  useDocumentTitle('Compare', doc?.name, project?.name);

  const report = readAdjudication(doc.raw, doc.layerInfo.sentenceTokenLayer?.tokens);
  const canRun = canEditProject(project, user);

  // The project's other documents, for the picker. The one the last report
  // was against is the natural default.
  const [documents, setDocuments] = useState(null);
  const [listError, setListError] = useState(null);
  useEffect(() => {
    let live = true;
    client.projects
      .listDocuments(projectId)
      .then((list) => live && setDocuments((list || []).filter((d) => d.id !== documentId)))
      .catch(
        (error) => live && setListError(humanizeError(error, 'Failed to list the documents.')),
      );
    return () => {
      live = false;
    };
  }, [client, projectId, documentId]);
  const [againstId, setAgainstId] = useState(null);
  const chosenId = againstId ?? report?.against?.id ?? null;

  // The other side of the report, read live: its graphs are what the right
  // column shows. A document that has gone since says so.
  const [other, setOther] = useState(null);
  const [otherError, setOtherError] = useState(null);
  const otherId = report?.against?.id || null;
  useEffect(() => {
    let live = true;
    setOther(null);
    setOtherError(null);
    if (!otherId) return undefined;
    UmrDocument.load({ client, documentId: otherId, projectId, project, user })
      .then((loaded) => live && setOther(loaded))
      .catch((error) => live && setOtherError(humanizeError(error, 'Failed to load it.')));
    return () => {
      live = false;
    };
  }, [client, otherId, projectId, project, user]);

  const rows = useMemo(() => (report ? scoreRows(report) : []), [report]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h3 className="text-xl font-semibold tracking-tight">Compare</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            This document scored against another document of the same text, with AnCast.
          </p>
        </div>
        {canRun && (
          <CompareDialog
            compare={services.compare}
            isDiscovering={services.isDiscovering}
            writeLockHeld={writeLockHeld}
            documents={documents}
            listError={listError}
            chosenId={chosenId}
            onChoose={setAgainstId}
          />
        )}
      </div>

      {!report && (
        <p className="text-sm text-muted-foreground" data-testid="compare-empty">
          No comparison yet.
        </p>
      )}

      {report && (
        <>
          <div className="rounded-md border p-4" data-testid="compare-report">
            <p className="text-sm">
              Against{' '}
              <Link
                className="font-medium underline underline-offset-2"
                to={`/projects/${projectId}/documents/${report.against?.id}/annotate`}
              >
                {report.against?.name || report.against?.id}
              </Link>
              , {formatWhen(report.at)}, {report.tool}.
              {report.scope === 'snt' ? ' Sentence graphs only.' : ''}
            </p>
            <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2">
              {rows.map((row) => (
                <div key={row.key} data-score={row.key}>
                  <dt className="text-xs text-muted-foreground">{row.label}</dt>
                  <dd
                    className="text-2xl font-semibold tabular-nums"
                    title={row.value == null ? 'Neither document has any' : undefined}
                  >
                    {percent(row.value)}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>Marked in the graphs:</span>
              <mark className={MARK_CLASS.missing}>No counterpart</mark>
              <mark className={MARK_CLASS.differs}>Paired with another concept</mark>
            </p>
          </div>

          {otherError && (
            <p className="text-sm text-warning-foreground">
              Failed to read the other document: {otherError}
            </p>
          )}

          <div className="flex flex-col gap-6">
            {(doc.sentences || []).map((sentence) => (
              <SentenceComparison
                key={sentence.index}
                sentence={sentence}
                row={sentenceReport(report, sentence.index)}
                left={doc.penmanOf(sentence.index)}
                right={other ? other.penmanOf(sentence.index) : null}
                otherName={report.against?.name || 'the other document'}
                thisHref={annotateHref(projectId, documentId)}
                otherHref={report.against?.id ? annotateHref(projectId, report.against.id) : null}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
};

// The Annotate tab of a document, opened on one sentence and, given a
// variable, on that node.
const annotateHref = (projectId, documentId) => (index, variable) => {
  const params = new URLSearchParams({ sent: String(index) });
  if (variable) params.set('var', variable);
  return `/projects/${projectId}/documents/${documentId}/annotate?${params}`;
};

// Whether either side's graph is not the one the report scored: an edit since
// the comparison. The report records the two graphs it scored, since the
// document's version cannot say which sentences moved.
const changedSince = (row, left, right) =>
  !!row && (row.thisGraph !== left || (right != null && row.otherGraph !== right));

const formatWhen = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleString() : 'undated';
};

// One sentence: its scores, and the two graphs side by side. On each side
// the variables of the nodes that disagree are marked, and the pairs are
// listed under them, the ones whose concepts differ first and with both
// concepts. The sentence number and each marked variable open Annotate on it.
function SentenceComparison({ sentence, row, left, right, otherName, thisHref, otherHref }) {
  const { mine, theirs } = sentenceMarks(row);
  const pairs = row?.matches || [];
  const differ = pairs.filter(conceptsDiffer);
  const same = pairs.filter((m) => !conceptsDiffer(m));
  return (
    <section className="rounded-md border" data-compare-sentence={sentence.index}>
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b px-4 py-2">
        <Link
          className="font-semibold tabular-nums underline-offset-2 hover:underline"
          to={thisHref(sentence.index)}
          data-sentence-link
        >
          {sentence.index}
        </Link>
        <span className="min-w-0 flex-1 truncate text-sm" dir="auto">
          {sentence.text}
        </span>
        {row?.skipped ? (
          <span className="text-xs text-warning-foreground">Not scored: {row.skipped}</span>
        ) : row ? (
          SENTENCE_SCORE_LABELS.map(([key, label]) => (
            <span key={key} className="text-xs text-muted-foreground" data-sentence-score={key}>
              {label} <span className="font-medium text-foreground">{percent(row[key])}</span>
            </span>
          ))
        ) : (
          <span className="text-xs text-muted-foreground">Not in the report</span>
        )}
        {changedSince(row, left, right) && (
          <span className="text-xs text-warning-foreground" data-changed-since>
            Changed since this comparison.
          </span>
        )}
      </header>
      <div className="grid gap-4 p-4 md:grid-cols-2">
        <GraphColumn
          title="This document"
          text={left}
          marks={mine}
          hrefFor={(v) => thisHref(sentence.index, v)}
        />
        <GraphColumn
          title={otherName}
          text={right}
          marks={theirs}
          hrefFor={otherHref ? (v) => otherHref(sentence.index, v) : null}
          placeholder={right == null ? 'Loading…' : undefined}
        />
      </div>
      {pairs.length > 0 && (
        <div className="flex flex-col gap-1 border-t px-4 py-2 text-xs text-muted-foreground">
          {differ.length > 0 && (
            <p data-pairs="differ">
              Paired with another concept:{' '}
              {differ.map((m) => (
                <Pair key={m.this} match={m} withConcepts />
              ))}
            </p>
          )}
          {same.length > 0 && (
            <p data-pairs="same">
              Same concept:{' '}
              {same.map((m) => (
                <Pair key={m.this} match={m} />
              ))}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

// One pair, `s1x = s1l`, with both concepts when they differ. A pair AnCast
// made only because both nodes were left over says so: it is no evidence the
// two nodes are the same node.
function Pair({ match, withConcepts = false }) {
  return (
    <span
      className={`mr-3 inline-block whitespace-nowrap font-mono ${withConcepts ? 'text-rose-900' : ''}`}
      data-pair={match.this}
    >
      {match.this}
      {withConcepts && ` ${match.thisConcept}`} = {match.other}
      {withConcepts && ` ${match.otherConcept}`}
      {match.leftover && (
        <span
          className="ml-1 font-sans italic text-muted-foreground"
          title="Paired from the nodes left once the rest were paired"
        >
          left over
        </span>
      )}
    </span>
  );
}

function GraphColumn({ title, text, marks, hrefFor, placeholder }) {
  const segments = markVariables(text || '', marks);
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs text-muted-foreground">{title}</p>
      <pre className="overflow-x-auto rounded-md bg-muted/40 p-3 font-mono text-xs leading-relaxed">
        {text ? (
          segments.map((seg, i) =>
            seg.mark ? (
              <mark key={i} className={MARK_CLASS[seg.mark]} data-mark={seg.mark}>
                {hrefFor ? (
                  <Link className="underline-offset-2 hover:underline" to={hrefFor(seg.text)}>
                    {seg.text}
                  </Link>
                ) : (
                  seg.text
                )}
              </mark>
            ) : (
              <span key={i}>{seg.text}</span>
            ),
          )
        ) : (
          <span className="text-muted-foreground">{placeholder || 'No graph'}</span>
        )}
      </pre>
    </div>
  );
}

// The Compare button and its dialog: which document to score against, the
// method, the run. The run belongs to the shell, so closing the dialog never
// cancels it.
function CompareDialog({
  compare,
  isDiscovering,
  writeLockHeld,
  documents,
  listError,
  chosenId,
  onChoose,
}) {
  const [open, setOpen] = useState(false);
  const { spot, run, start } = compare;
  const running = run.running;
  const busyElsewhere = !!writeLockHeld && !running;

  // No service online is the method row's to say, and said once.
  const notice = running
    ? null
    : busyElsewhere
      ? `${writeLockHeld.label} is running. One run at a time on a document.`
      : listError
        ? listError
        : documents && documents.length === 0
          ? 'This project has no other document to compare with.'
          : !chosenId
            ? 'Choose a document to compare with.'
            : null;

  return (
    <>
      <ServiceRunButton label="Compare" icon={Scale} onClick={() => setOpen(true)} progress={run} />
      <ServiceRunDialog
        open={open}
        onOpenChange={setOpen}
        title="Compare"
        icon={Scale}
        description="Scores this document's graphs against another document of the same text, and writes the report on this document."
        progress={run}
        notice={notice}
        runLabel="Compare"
        onRun={() => {
          setOpen(false);
          start({ against: chosenId });
        }}
        onCancel={compare.cancel}
        runDisabled={
          !!notice || running || spot.empty || Object.keys(spot.params.errors).length > 0
        }
      >
        <div className="flex flex-col gap-2">
          <Label className="text-xs">Compare with</Label>
          <Select value={chosenId ?? ''} onValueChange={onChoose} disabled={running || !documents}>
            <SelectTrigger data-testid="compare-against">
              <SelectValue placeholder="Document" />
            </SelectTrigger>
            <SelectContent>
              {(documents || []).map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <ServiceMethodRow
          spot={spot}
          disabled={running}
          emptyHint={
            isDiscovering
              ? 'Looking for a comparison service.'
              : 'No comparison service is online for this project.'
          }
        />
      </ServiceRunDialog>
    </>
  );
}
