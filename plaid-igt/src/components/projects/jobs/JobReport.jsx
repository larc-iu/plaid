import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Copy } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { AssistantMarkdown } from '@ui/components/assistant/AssistantMarkdown.jsx';
import { copyText } from '@ui/lib/download.js';
import { TYPE } from '@ui/lib/typeScale.js';
import { historyHref } from '@ui/hooks/useHistoryParam.js';
import { plural } from '@ui/lib/plural.js';
import { APP_ROUTES } from '@/appRoutes.js';
import {
  HARMONIZE_BY_TEXT,
  allSkipped,
  HARMONIZE_LEFT_TEXT,
  changeReasonText,
  changesGroup,
  changesText,
  sumParts,
  durationText,
  fieldValuesText,
  findingsPiecesText,
  noticeCounts,
  noticeText,
  notReadThrough,
  refusedText,
  skippedText,
  stoppedPartway,
} from './jobText.js';
import SECTIONS from './jobSections.json';

// A finished job's report (CONTRACT 5.3, as the client hands it over, keys in
// camelCase): the totals, the summary the assistant wrote under a heading
// that says so (or first, the worker's one line for a job that wrote and
// proposed nothing, `summaryBy` worker), the changes it proposed,
// each piece's note, the tables its code made, each document's skipped
// sentences and the targets it left blank (or that its document could not be
// read for them, `leftUnread`, and how much is blank in the sentences it did
// not reach, `notReached`, and in those it skipped, `skipped`), what harmonize changed and left,
// the entries the job made, and those of them nothing links (the job runs no
// cleanup of its own: a person deletes them).
// Every list the worker cut says how many it left out. A section's heading is
// jobSections.json's, which the assistant names sections by (read_job).

const Heading = ({ section, children }) => (
  <h3 className={`${TYPE.card} mb-2 mt-6`}>{section ? SECTIONS[section] : children}</h3>
);

const More = ({ n, noun }) =>
  n > 0 ? (
    <p className="mt-1 text-sm text-muted-foreground">
      And {n.toLocaleString()} more {plural(n, noun)}.
    </p>
  ) : null;

// What is still blank of each thing the job fills (the plan's targets, by
// name): the totals' rows, or, when the totals hold none, the documents' rows
// summed by target in the order they come. Each `{target, unit, left,
// notReached, skipped}`, `unit` a word, a morpheme or a sentence (what Left
// blank lists).
// A job that fills nothing has none, and core's own report of a job no worker
// finished counts none.
const blankSums = (report) => {
  if (report.totals?.blank) return report.totals.blank;
  const sums = new Map();
  (report.documents || []).forEach((d) =>
    (d.counts?.blank || []).forEach((b) => {
      const s = sums.get(b.target) ?? {
        target: b.target,
        unit: b.unit,
        left: 0,
        untouched: 0,
        notReached: 0,
        skipped: 0,
      };
      s.left += b.left ?? 0;
      s.untouched += b.untouched ?? 0;
      s.notReached += b.notReached ?? 0;
      s.skipped += b.skipped ?? 0;
      sums.set(b.target, s);
    }),
  );
  return [...sums.values()];
};

// A count of what a target holds blank, in the unit Left blank lists.
const unitCount = (n, unit) => `${n.toLocaleString()} ${plural(n, unit)}`;

// Rows `{field, id, values, inAnalyses?, outside?}` summed by the target's id (each row
// carries it, REV-SUFIX-2), named as the first row names it.
const sumById = (rows, into = new Map()) => {
  rows.forEach((f) => {
    const s = into.get(f.id) ?? { field: f.field, id: f.id, values: 0 };
    s.values += f.values ?? 0;
    if (f.inAnalyses > 0) s.inAnalyses = (s.inAnalyses ?? 0) + f.inAnalyses;
    if (f.outside === true) s.outside = true;
    into.set(f.id, s);
  });
  return into;
};

// What the job wrote outside its setup, a row per target (the worker's
// `outside` rows, decided by id where it was written: values of a field, a
// translation or an orthography, and segmentation, one per word or morpheme,
// REV-SUFIX-1): the totals', or the documents' summed by id.
const outsideRows = (report) => [
  ...sumById(
    report.totals?.outside ?? (report.documents || []).flatMap((d) => d.counts?.outside || []),
  ).values(),
];

// The values the job set in each target, in the order of their names: the
// totals' field rows, or, when the totals hold none (core's own report of a
// job no worker finished sums named counts only), the documents' summed by id.
// A target written outside the setup reads the count of its `outside` row,
// which also holds the values an analysis carries and a translation, so each
// such target has a row and those rows sum to the total.
const fieldSums = (report) => {
  const sums = report.totals?.fields
    ? sumById(report.totals.fields)
    : sumById((report.documents || []).flatMap((d) => d.counts?.fields || []));
  outsideRows(report).forEach((f) =>
    sums.set(f.id, { ...f, inAnalyses: sums.get(f.id)?.inAnalyses, outside: true }),
  );
  return [...sums.values()].sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
};

// What the job's changes are, by kind (the worker's `changes_parts`): the
// totals', or, when they hold none (core's own report), the documents' summed.
const changeParts = (report) =>
  report.totals?.changesParts ??
  sumParts((report.documents || []).map((d) => d.counts?.changesParts));

// How many values the job wrote outside its setup: the sum of its rows.
const outsideSum = (report) => outsideRows(report).reduce((n, f) => n + f.values, 0);

// One "label: value" row of the totals, left out when it is an optional row
// with nothing in it. The values the job set in each field follow the words
// it analyzed, one row per field ("Thematic role: 107 values"), then what is
// still blank of each thing the job fills, in the worked sentences and in
// those it did not reach ("Role left blank: 7 words"), so the rows sum.
const totalRows = (report) => {
  const t = report.totals || {};
  // A document done by skipping every sentence of it is counted as the
  // Documents table says it, skipped (REV-RPF-P-9, REV-RPF2-8).
  const skippedDocs = (report.documents || []).filter(allSkipped).length;
  // So is one the step over all documents did not read through (RPF3-A).
  const unreadDocs = (report.documents || []).filter(notReadThrough).length;
  const rows = [['Documents done', Math.max(0, (t.documentsDone ?? 0) - skippedDocs - unreadDocs)]];
  const optional = (label, n) => n > 0 && rows.push([label, n]);
  optional('Documents not read through', unreadDocs);
  optional('Documents skipped', skippedDocs);
  optional('Documents in use', t.documentsInUse);
  optional('Documents deleted', t.documentsGone);
  // A document the job did not finish reads "stopped partway" once it
  // finished a sentence, by the report's own rows.
  const unfinished = (report.documents || []).filter((d) => d.state === 'not-reached');
  const partway = unfinished.filter(stoppedPartway).length;
  optional(
    'Documents not reached',
    report.documents ? unfinished.length - partway : t.documentsNotReached,
  );
  optional('Documents stopped partway', partway);
  rows.push(['Sentences written in', t.sentences]);
  // One definition of a change, said in its parts (RP-3, RP-6).
  if (t.changes > 0) rows.push(['Changes written', changesText(t.changes, changeParts(report))]);
  optional('Deletions', t.deletions);
  // What the job changed of what people wrote, by provenance, and of the
  // text: each document's History entry shows the changes (REV-DAY-S-3).
  optional('People’s values, morphemes and links changed or removed', t.peoplesValuesChanged);
  optional('Changes to the text', t.textChanges);
  // What the text edits did to the words (RP-6).
  optional('Words added', t.wordsAdded);
  optional('Existing words or punctuation marks changed or removed', t.tokensChanged);
  optional('Translations written', t.translations);
  optional('Translations replaced', t.refreshed);
  optional('Words analyzed', t.words);
  fieldSums(report).forEach((f) => f.values > 0 && rows.push([f.field, fieldValuesText(f)]));
  optional('Values not in the setup', outsideSum(report));
  blankSums(report).forEach((b) => {
    // A target is named as everywhere on the page, "segmentation" too (N-1).
    rows.push([`${b.target} left blank`, unitCount(b.left ?? 0, b.unit)]);
    // Counted, never listed: blank in sentences the job worked and wrote
    // nothing in (RP-3, RP-6).
    if (b.untouched > 0) {
      rows.push([
        `${b.target} blank in sentences the job did not change`,
        unitCount(b.untouched, b.unit),
      ]);
    }
    if (b.notReached > 0) {
      rows.push([`${b.target} blank in sentences not reached`, unitCount(b.notReached, b.unit)]);
    }
    if (b.skipped > 0) {
      rows.push([`${b.target} blank in skipped sentences`, unitCount(b.skipped, b.unit)]);
    }
  });
  optional('Lexicon links made', t.links);
  optional('Entries created', t.entries);
  optional('Changes proposed', t.proposed);
  optional('Sentences skipped as too long', t.skippedTooLong);
  optional('Sentences skipped as failed', t.skippedFailed);
  optional('Sentences skipped as changed during the job', t.skippedChanged);
  optional('Sentences skipped after an interrupted write', t.skippedInterrupted);
  optional('Sentences skipped with no answer from the assistant', t.skippedNoAnswer);
  optional('Sentences skipped and not listed', t.skippedMore);
  optional('Changes not written, changed during the job', t.changed);
  optional('Changes left out, sentence written before an interruption', t.repeated);
  return rows.map(([label, n]) => [label, typeof n === 'string' ? n : (n ?? 0).toLocaleString()]);
};

const Analysis = ({ text, count }) => (
  <span className="whitespace-nowrap">
    {text}
    {count !== undefined && <span className="text-muted-foreground"> ×{count}</span>}
  </span>
);

// An entry the job made, a link to it where the report names its lexicon.
const EntryLine = ({ entry }) => {
  const text = `${entry.form}${entry.gloss ? ` ‘${entry.gloss}’` : ''}`;
  return (
    <li>
      {entry.id && entry.lexicon ? (
        <Link
          className="underline"
          to={`/vocabularies/${entry.lexicon}?item=${encodeURIComponent(entry.id)}`}
        >
          {text}
        </Link>
      ) : (
        text
      )}
    </li>
  );
};

// A document of the report by its name, a link to what the job changed in it
// (its History entry for the job's work there) where it wrote something.
const DocumentName = ({ projectId, d }) =>
  d.name && changesGroup(d) ? (
    <Link
      className="font-medium underline"
      to={historyHref(APP_ROUTES.document(projectId, d.documentId), d.glossGroup)}
    >
      {d.name}
    </Link>
  ) : (
    <span className="font-medium">{d.name ?? 'Deleted document'}</span>
  );

// How much of each thing the job fills is blank in the sentences of a
// document the job did not reach, or skipped (`key`): counted, never listed.
const blankParts = (counts, key) =>
  (counts?.blank || [])
    .filter((b) => b[key] > 0)
    .map((b) => `${b.target} ${unitCount(b[key], b.unit)}`);

const BLANK_ELSEWHERE = [
  ['untouched', 'Blank in sentences the job did not change'],
  ['notReached', 'Blank in sentences not reached'],
  ['skipped', 'Blank in skipped sentences'],
];

const BlankElsewhere = ({ counts }) =>
  BLANK_ELSEWHERE.map(([key, label]) => {
    const parts = blankParts(counts, key);
    return parts.length ? (
      <p key={key} className="ml-4 text-muted-foreground">
        {label}: {parts.join(', ')}.
      </p>
    ) : null;
  });

// What a refusal the job could not follow left in a document's sentences
// (`refused`): each sentence, linked into the grid, with a fixed label for
// the kind of refusal (`code`). The refusal's own text is the model's, for
// read_job and the final context. Never counted as left blank.
const Refused = ({ projectId, d }) => {
  const list = d.refused || [];
  if (!list.length && !(d.refusedMore > 0)) return null;
  return (
    <>
      <p className="ml-4 mt-1">Not done, refused:</p>
      <ul className="ml-8 list-disc">
        {list.map((r, i) => (
          <li key={`${r.sentenceId ?? r.sentence} ${i}`}>
            {d.name && r.sentenceId ? (
              <Link
                className="underline"
                to={APP_ROUTES.sentence(projectId, d.documentId, r.sentenceId)}
              >
                {r.sentence}
              </Link>
            ) : (
              r.sentence
            )}{' '}
            <span className="text-muted-foreground">{refusedText(r.code)}</span>
          </li>
        ))}
      </ul>
      {d.refusedMore > 0 && (
        <p className="ml-8 text-muted-foreground">
          And {d.refusedMore.toLocaleString()} more refused.
        </p>
      )}
    </>
  );
};

// The changes the job staged and did not apply (the apply rule: project
// setup, and the few it cannot make under a document's lock), each where it
// is, from what to what, and the note of the piece that staged it: what a
// person approves in a conversation with the assistant about the job. Then,
// under a line of their own, the changes it applied whose write was cut short
// and that were not written (`reason`). Hidden when there are none.
const ChangesTable = ({ list, projectId }) => (
  <table className="w-full text-sm">
    <thead className="text-left text-muted-foreground">
      <tr>
        <th className="py-1 pr-4 font-medium">Where</th>
        <th className="py-1 pr-4 font-medium">Change</th>
        <th className="py-1 pr-4 font-medium">From</th>
        <th className="py-1 font-medium">To</th>
      </tr>
    </thead>
    <tbody>
      {list.map((c, i) => (
        <tr key={i} className="border-t align-top">
          <td className="py-1 pr-4">
            {c.documentId ? (
              <Link
                className="underline"
                to={`/projects/${projectId}/documents/${c.documentId}`}
              >{`${c.document ?? 'Document'}${c.ref ? ` ${c.ref}` : ''}`}</Link>
            ) : (
              <span className="text-muted-foreground">Project</span>
            )}
          </td>
          <td className="py-1 pr-4">{c.field ?? c.label}</td>
          <td className="py-1 pr-4 text-muted-foreground" dir="auto">
            {c.from ?? ''}
          </td>
          <td className="py-1" dir="auto">
            {c.to ?? ''}
          </td>
        </tr>
      ))}
    </tbody>
  </table>
);

const ProposedChanges = ({ report, projectId }) => {
  const list = report.proposed || [];
  const more = report.proposedMore || 0;
  if (!list.length && !more) return null;
  const staged = list.filter((c) => !c.reason);
  const unwritten = list.filter((c) => c.reason);
  return (
    <>
      <Heading section="proposed" />
      {staged.length > 0 && <ChangesTable list={staged} projectId={projectId} />}
      {unwritten.length > 0 && (
        <>
          <p className={`text-sm font-medium ${staged.length ? 'mt-3' : ''}`}>
            {changeReasonText(unwritten[0].reason)}
          </p>
          <ChangesTable list={unwritten} projectId={projectId} />
        </>
      )}
      <More n={more} noun="change" />
    </>
  );
};

// The documents of the job its plan did not work, and how many a report too
// large for core could not list.
const LeftOut = ({ report, projectId }) => {
  const list = report.plan?.leftOut || [];
  const more = report.plan?.leftOutMore || 0;
  if (!list.length && !more) return null;
  return (
    <>
      <Heading section="plan.left_out" />
      <ul className="ml-4 list-disc text-sm">
        {list.map((d) => (
          <li key={d.documentId}>
            {d.name === null || d.name === undefined ? (
              <span className="text-muted-foreground">Deleted document</span>
            ) : (
              <Link
                className="hover:underline"
                to={`/projects/${projectId}/documents/${d.documentId}`}
              >
                {d.name}
              </Link>
            )}
          </li>
        ))}
      </ul>
      <More n={more} noun="document" />
    </>
  );
};

// What the assistant wrote, as the chat renders the assistant's text: never
// raw Markdown marks (RP-1, RP-4). `inline` for a note in a list.
const Written = ({ text, inline = false, ...rest }) => (
  <div
    dir="auto"
    className={
      inline ? 'min-w-0 [&_.prose>:first-child]:mt-0 [&_.prose>:last-child]:mb-0' : 'max-w-3xl'
    }
    {...rest}
  >
    <AssistantMarkdown>{text}</AssistantMarkdown>
  </div>
);
export { Written as JobWritten };

// Each piece's note, as the model ended it.
const PieceNotes = ({ report }) => {
  const notes = report.notes || [];
  if (!notes.length && !(report.notesMore > 0)) return null;
  return (
    <>
      <Heading section="notes" />
      <ul className="ml-4 list-disc text-sm">
        {notes.map((n, i) => (
          <li key={i}>
            {(n.name || n.sentences) && (
              <span className="text-muted-foreground">
                {[n.name, n.sentences].filter(Boolean).join(' ')}:{' '}
              </span>
            )}
            <Written text={n.note || ''} inline />
          </li>
        ))}
      </ul>
      <More n={report.notesMore || 0} noun="note" />
    </>
  );
};

// What the job's code counted, as data, and how many tables the report could
// not hold.
const Tables = ({ tables, more = 0 }) =>
  tables.length || more > 0 ? (
    <>
      <Heading section="tables" />
      {tables.map((t, i) => (
        <div key={i} className="mb-4 text-sm">
          <p className="font-medium">{t.title}</p>
          <table className="w-full">
            <thead className="text-left text-muted-foreground">
              <tr>
                {(t.columns || []).map((c, j) => (
                  <th key={j} className="py-1 pr-4 font-medium">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(t.rows || []).map((r, j) => (
                <tr key={j} className="border-t">
                  {r.map((v, k) => (
                    <td key={k} className="py-1 pr-4" dir="auto">
                      {v === null ? '' : String(v)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <More n={t.more || 0} noun="row" />
        </div>
      ))}
      <More n={more} noun="table" />
    </>
  ) : null;

// The line under the model's own text on the page, the summary's and the
// findings' alike (R4, REV-RPF-P-4): where the worker's counts stand from it.
const byTheAssistant = (where) =>
  `Written by the assistant, not checked against the counts ${where}.`;

// The one report of a job that fills nothing (`findings`, Markdown, CONTRACT,
// added by RPF), in full, with a way to copy it as written (RP-4).
export const JobFindings = ({ findings, pieces = null, cut = null }) => {
  const piecesLine = findingsPiecesText(pieces, cut);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <section aria-label="Findings" className="mb-8" data-testid="job-findings">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className={TYPE.section}>Findings</h2>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={async () => setCopied(await copyText(findings, 'The findings were not copied.'))}
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          Copy
        </Button>
      </div>
      <p className="mb-2 text-sm text-muted-foreground" data-testid="job-findings-by">
        {byTheAssistant('below')}
      </p>
      {piecesLine && (
        <p className="mb-2 text-sm text-muted-foreground" data-testid="job-findings-pieces">
          {piecesLine}
        </p>
      )}
      <Written text={findings} />
    </section>
  );
};

export const JobReport = ({ report, projectId, vocabs = [] }) => {
  const paused = [
    ['Paused for people', report.pausedForPeopleS],
    ['Waiting for the model', report.pausedForModelS],
  ].filter(([, s]) => s > 0);
  const skipped = (report.documents || []).filter((d) => d.skipped?.length);
  const blank = (report.documents || []).filter(
    (d) =>
      d.left?.length ||
      d.leftMore > 0 ||
      d.leftUnread ||
      BLANK_ELSEWHERE.some(([key]) => blankParts(d.counts, key).length > 0) ||
      d.refused?.length ||
      d.refusedMore > 0,
  );
  const harmonize = report.harmonize || {};
  const entries = report.entries || {};
  const changed = harmonize.changed || [];
  const left = harmonize.left || [];
  // The project's lexicons the job created entries in, in the project's order.
  const madeIn = new Set(entries.lexicons || []);
  const draftLexicons = vocabs.filter((v) => madeIn.has(v.id));
  const entryLists = [['Created', entries.created, entries.createdMore]].filter(
    ([, list = [], more = 0]) => list.length || more,
  );
  const unlinked = entries.unlinked || [];
  const notice = report.notice !== undefined ? report.notice : noticeText(noticeCounts(report));

  return (
    <section aria-label="Report">
      <h2 className={`${TYPE.section} mt-8`}>Report</h2>
      {report.stopped === 'without-worker' && (
        <p className="mt-2 text-sm text-muted-foreground">Stopped with no worker running.</p>
      )}
      {/* The worker's own line, from its counts, where the job changed
          people's work or the text (R4). Core's own report, of a job no
          worker finished, has none: the same line from its counts
          (REV-RPF-W-3). */}
      {notice && (
        <p className="mt-3 max-w-2xl text-sm font-medium" data-testid="job-notice">
          {notice}
        </p>
      )}
      {report.summary && report.summaryBy === 'worker' && (
        <p className="mt-3 max-w-2xl text-sm" data-testid="job-summary">
          {report.summary}
        </p>
      )}

      <Heading>Totals</Heading>
      <dl className="grid max-w-xl grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm">
        {[...totalRows(report), ...paused.map(([l, s]) => [l, durationText(s * 1000)])].map(
          ([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="text-right tabular-nums">{value}</dd>
            </div>
          ),
        )}
      </dl>

      {((report.summary && report.summaryBy !== 'worker') || report.summaryFailed) && (
        <Heading>Assistant’s summary</Heading>
      )}
      {/* The model's account, after the counts and marked as its own (R4). */}
      {report.summary && report.summaryBy !== 'worker' && (
        <>
          <p className="mb-2 text-sm text-muted-foreground">{byTheAssistant('above')}</p>
          <Written text={report.summary} data-testid="job-summary" />
        </>
      )}
      {report.summaryFailed && (
        <p className="text-sm text-muted-foreground">The summary could not be written.</p>
      )}

      <LeftOut report={report} projectId={projectId} />
      <ProposedChanges report={report} projectId={projectId} />
      <PieceNotes report={report} />
      <Tables tables={report.tables || []} more={report.tablesMore || 0} />

      {skipped.length > 0 && (
        <>
          <Heading section="skipped" />
          {skipped.map((d) => (
            <div key={d.documentId} className="mb-3 text-sm">
              <p>
                <DocumentName projectId={projectId} d={d} />
              </p>
              <ul className="ml-4 list-disc">
                {d.skipped.map((s) => (
                  <li key={s.sentenceId ?? s.sentence}>
                    {d.name && s.sentenceId ? (
                      <Link
                        className="underline"
                        to={APP_ROUTES.sentence(projectId, d.documentId, s.sentenceId)}
                      >
                        {s.sentence}
                      </Link>
                    ) : (
                      s.sentence
                    )}{' '}
                    <span className="text-muted-foreground">{skippedText(s)}</span>
                  </li>
                ))}
              </ul>
              {d.counts?.skippedMore > 0 && (
                <p className="ml-4 text-muted-foreground">
                  And {d.counts.skippedMore.toLocaleString()} more skipped.
                </p>
              )}
            </div>
          ))}
        </>
      )}

      {blank.length > 0 && (
        <>
          <Heading section="left" />
          {blank.map((d) => (
            <div key={d.documentId} className="mb-3 text-sm">
              <p>
                <DocumentName projectId={projectId} d={d} />
              </p>
              <ul className="ml-4 list-disc">
                {(d.left || []).map((l) => (
                  <li key={`${l.sentenceId} ${l.ref}`}>
                    {d.name && l.sentenceId ? (
                      <Link
                        className="underline"
                        to={APP_ROUTES.sentence(projectId, d.documentId, l.sentenceId, {
                          word: l.begin ?? undefined,
                        })}
                      >
                        {l.ref}
                      </Link>
                    ) : (
                      l.ref
                    )}{' '}
                    {l.form !== null && l.form !== undefined && (
                      <>
                        <span dir="auto">{l.form}</span>{' '}
                      </>
                    )}
                    <span className="text-muted-foreground">{(l.targets || []).join(', ')}</span>
                  </li>
                ))}
              </ul>
              {d.leftMore > 0 && (
                <p className="ml-4 text-muted-foreground">
                  And {d.leftMore.toLocaleString()} more left blank.
                </p>
              )}
              {d.leftUnread && <p className="ml-4 text-muted-foreground">Could not be read.</p>}
              <BlankElsewhere counts={d.counts} />
              <Refused projectId={projectId} d={d} />
            </div>
          ))}
        </>
      )}

      {(changed.length > 0 || harmonize.changedMore > 0) && (
        <>
          <Heading section="harmonize.changed" />
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1 pr-4 font-medium">Form</th>
                <th className="py-1 pr-4 font-medium">Set to</th>
                <th className="py-1 pr-4 font-medium">Decided by</th>
                <th className="py-1 font-medium">Replaced</th>
              </tr>
            </thead>
            <tbody>
              {changed.map((c) => (
                <tr key={`${c.form}|${c.to}`} className="border-t align-top">
                  <td className="py-1 pr-4">{c.form}</td>
                  <td className="py-1 pr-4">
                    <Analysis text={c.to} />
                  </td>
                  <td className="py-1 pr-4">{HARMONIZE_BY_TEXT[c.by] ?? c.by}</td>
                  <td className="py-1">
                    {(c.from || []).map((f) => (
                      <div key={f.analysis}>
                        <Analysis text={f.analysis} count={f.count} />
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <More n={harmonize.changedMore} noun="form" />
        </>
      )}

      {(left.length > 0 || harmonize.leftMore > 0) && (
        <>
          <Heading section="harmonize.left" />
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1 pr-4 font-medium">Form</th>
                <th className="py-1 pr-4 font-medium">Analyses</th>
                <th className="py-1 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody>
              {left.map((l) => (
                <tr key={`${l.form}|${l.reason}`} className="border-t align-top">
                  <td className="py-1 pr-4">{l.form}</td>
                  <td className="py-1 pr-4">
                    {(l.analyses || []).map((a) => (
                      <div key={a.analysis}>
                        <Analysis text={a.analysis} count={a.count} />
                      </div>
                    ))}
                  </td>
                  <td className="py-1">{HARMONIZE_LEFT_TEXT[l.reason] ?? l.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <More n={harmonize.leftMore} noun="form" />
        </>
      )}

      {(entryLists.length > 0 || draftLexicons.length > 0) && (
        <>
          <Heading>Entries</Heading>
          {entryLists.map(([label, list = [], more = 0]) => (
            <div key={label} className="mb-3 text-sm">
              <p className="font-medium">{label}</p>
              <ul className="ml-4 list-disc">
                {list.map((e) => (
                  <EntryLine key={e.id ?? `${e.lexicon} ${e.form} ${e.gloss}`} entry={e} />
                ))}
              </ul>
              <More n={more} noun="entry" />
            </div>
          ))}
          {draftLexicons.length > 0 && (
            <ul className="flex flex-col gap-1 text-sm">
              {draftLexicons.map((v) => (
                <li key={v.id}>
                  <Link className="underline" to={`/vocabularies/${v.id}?status=machine`}>
                    Machine drafts in {v.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {(unlinked.length > 0 || entries.unlinkedMore > 0) && (
        <>
          <Heading section="entries.unlinked" />
          <ul className="ml-4 list-disc text-sm">
            {unlinked.map((e) => (
              <li key={e.id}>
                <Link className="underline" to={`/vocabularies/${e.lexicon}?item=${e.id}`}>
                  {e.form}
                  {e.gloss ? ` ‘${e.gloss}’` : ''}
                </Link>
              </li>
            ))}
          </ul>
          <More n={entries.unlinkedMore || 0} noun="entry" />
        </>
      )}
    </section>
  );
};
