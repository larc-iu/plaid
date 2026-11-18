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
  HARMONIZE_LEFT_TEXT,
  changeReasonText,
  changesGroup,
  findingsPiecesText,
  refusedText,
  skippedText,
} from './jobText.js';
import SECTIONS from './jobSections.json';
import {
  BLANK_ELSEWHERE,
  NOT_WRITTEN,
  blankParts,
  draftLexiconsOf,
  pausedRows,
  totalRows,
} from './jobTotals.js';

// The blocks of a finished job's report (CONTRACT 5.3, as the client hands it
// over, keys in camelCase), each drawn by the job page in its Overview or in a
// section of its own (JobSections.jsx): the totals, the summary the assistant
// wrote under a heading that says so, the changes it proposed, the tables its
// code made, each document's skipped sentences and the targets it left blank
// (or that its document could not be read for them, `leftUnread`, and how much
// is blank in the sentences it did not reach, `notReached`, and in those it
// skipped, `skipped`), what harmonize changed and left, the entries the job
// made, and those of them nothing links (the job runs no cleanup of its own: a
// person deletes them). Every list the worker cut says how many it left out. A
// list's heading is jobSections.json's, which the assistant names sections by
// (read_job).

export const Heading = ({ section, children }) => (
  <h3 className={`${TYPE.card} mb-2 mt-6`}>{section ? SECTIONS[section] : children}</h3>
);

const More = ({ n, noun }) =>
  n > 0 ? (
    <p className="mt-1 text-sm text-muted-foreground">
      And {n.toLocaleString()} more {plural(n, noun)}.
    </p>
  ) : null;

const Analysis = ({ text, count }) => (
  <span className="whitespace-nowrap">
    {text}
    {count !== undefined && <span className="text-muted-foreground"> ×{count}</span>}
  </span>
);

// An entry the job made, a link to it where the report names its lexicon,
// and said to sit beside an entry of the same form the job did not make
// (`besideExisting`, RPF3 round 4).
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
      {entry.besideExisting && (
        <span className="text-muted-foreground">, beside an existing entry of this form</span>
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

// The words the job's text edits respelled and left their analysis on: their
// morpheme forms still spell the old word (the worker's `respelled`, CONTRACT,
// added by RPF3), each linked into the grid at its sentence.
export const Respelled = ({ report, projectId }) => {
  const list = report.respelled || [];
  const more = report.respelledMore || 0;
  if (!list.length && !more) return null;
  return (
    <>
      <Heading section="respelled" />
      <ul className="ml-4 list-disc text-sm">
        {list.map((r) => (
          <li key={`${r.sentenceId} ${r.ref}`}>
            {r.name ?? 'Deleted document'}{' '}
            {r.name && r.sentenceId ? (
              <Link
                className="underline"
                to={APP_ROUTES.sentence(projectId, r.documentId, r.sentenceId)}
              >
                {r.ref}
              </Link>
            ) : (
              r.ref
            )}{' '}
            <span dir="auto">{r.form}</span>{' '}
            <span className="text-muted-foreground">
              was <span dir="auto">{r.old}</span>, morphemes{' '}
              <span dir="auto">{(r.morphemes || []).join(' ')}</span>
            </span>
          </li>
        ))}
      </ul>
      <More n={more} noun="word" />
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

export const ProposedChanges = ({ report, projectId }) => {
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
export const LeftOut = ({ report, projectId }) => {
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
// The model's Markdown headings sit one level under the page's own (TYPE.card,
// the headings of the job page's Overview), whatever level it wrote them at.
const UNDER_THE_PAGE =
  '[&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-sm [&_h4]:text-sm [&_h5]:text-sm [&_h6]:text-sm';
const Written = ({ text, inline = false, className = '', ...rest }) => (
  <div
    dir="auto"
    className={`${
      inline
        ? 'min-w-0 [&_.prose>:first-child]:mt-0 [&_.prose>:last-child]:mb-0'
        : `max-w-3xl ${UNDER_THE_PAGE}`
    } ${className}`}
    {...rest}
  >
    <AssistantMarkdown>{text}</AssistantMarkdown>
  </div>
);
export { Written as JobWritten };

// Each piece's note is on its row of the work list (JobActivity), and the
// report does not repeat them (RPF3-E, RP2-1 finding 5). `report.notes`
// stays for read_job and the final context.

// What the job's code counted, as data, and how many tables the report could
// not hold.
export const Tables = ({ tables, more = 0 }) =>
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
    <section aria-label="Findings" className="mt-6" data-testid="job-findings">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className={TYPE.card}>Findings</h3>
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

// The report's totals, label and value, under their heading.
export const TotalsList = ({ report, undone = null }) => {
  const rows = [...totalRows(report), ...pausedRows(report)];
  const groups = [
    ['Written', rows.filter(([, , g]) => g !== NOT_WRITTEN)],
    ['Not written', rows.filter(([, , g]) => g === NOT_WRITTEN)],
  ].filter(([, list]) => list.length);
  return (
    <>
      <Heading>{undone ? 'What the job had written' : 'Totals'}</Heading>
      <div className="grid max-w-4xl gap-x-12 gap-y-5 lg:grid-cols-2">
        {groups.map(([name, list]) => (
          <div key={name} className="min-w-0">
            <p className="mb-1 text-xs font-medium text-muted-foreground">{name}</p>
            <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-1 text-sm">
              {list.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="text-right tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </>
  );
};

// A summary longer than this is folded, with a control to show all of it.
const SUMMARY_FOLDED_CHARS = 600;

// The model's account, after the counts and marked as its own (R4), folded
// when long, or that it could not be written.
export const AssistantSummary = ({ report }) => {
  const [open, setOpen] = useState(false);
  const shown = report.summary && report.summaryBy !== 'worker';
  const long = shown && [...report.summary].length > SUMMARY_FOLDED_CHARS;
  return (
    <>
      {(shown || report.summaryFailed) && <Heading>Assistant’s summary</Heading>}
      {shown && (
        <>
          <p className="mb-2 text-sm text-muted-foreground">{byTheAssistant('above')}</p>
          <Written
            text={report.summary}
            data-testid="job-summary"
            className={
              long && !open
                ? 'max-h-60 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]'
                : ''
            }
          />
          {long && (
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
            >
              {open ? 'Show less' : 'Show all'}
            </Button>
          )}
        </>
      )}
      {report.summaryFailed && (
        <p className="text-sm text-muted-foreground">The summary could not be written.</p>
      )}
    </>
  );
};

// One document's skipped sentences, each linked into the grid.
export const SkippedDocument = ({ d, projectId }) => (
  <div className="mb-3 text-sm">
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
);

// One document's places left blank, each linked into the grid, what is blank
// in its other sentences, and what a refusal left undone there.
export const BlankDocument = ({ d, projectId }) => (
  <div className="mb-3 text-sm">
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
);

// What harmonize set each form to, and from what.
export const HarmonizeChanged = ({ list, more = 0 }) => (
  <>
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
        {list.map((c) => (
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
    <More n={more} noun="form" />
  </>
);

// The forms harmonize left inconsistent, and why.
export const HarmonizeLeft = ({ list, more = 0 }) => (
  <>
    <table className="w-full text-sm">
      <thead className="text-left text-muted-foreground">
        <tr>
          <th className="py-1 pr-4 font-medium">Form</th>
          <th className="py-1 pr-4 font-medium">Analyses</th>
          <th className="py-1 font-medium">Reason</th>
        </tr>
      </thead>
      <tbody>
        {list.map((l) => (
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
    <More n={more} noun="form" />
  </>
);

// The entries the job made, the machine drafts in each lexicon, and those of
// them nothing links.
export const Entries = ({ report, vocabs = [] }) => {
  const entries = report.entries || {};
  const draftLexicons = draftLexiconsOf(report, vocabs);
  const entryLists = [['Created', entries.created, entries.createdMore]].filter(
    ([, list = [], more = 0]) => list.length || more,
  );
  const unlinked = entries.unlinked || [];
  return (
    <>
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
    </>
  );
};
