import { Link } from 'react-router-dom';
import { TYPE } from '@ui/lib/typeScale.js';
import { plural } from '@ui/lib/plural.js';
import { APP_ROUTES } from '@/appRoutes.js';
import { HARMONIZE_BY_TEXT, HARMONIZE_LEFT_TEXT, durationText, skippedText } from './jobText.js';
import SECTIONS from './jobSections.json';

// A finished job's report (CONTRACT 5.3, as the client hands it over, keys in
// camelCase): the summary the job wrote, the totals, the changes it proposed,
// each piece's note, the tables its code made, each document's skipped
// sentences and the targets it left blank, what harmonize changed and left,
// the entries the job made, and those of them nothing links (a job deletes
// nothing: a person deletes them).
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

// One "label: value" row of the totals, left out when it is an optional row
// with nothing in it.
const totalRows = (report) => {
  const t = report.totals || {};
  const rows = [['Documents done', t.documentsDone]];
  const optional = (label, n) => n > 0 && rows.push([label, n]);
  optional('Documents in use', t.documentsInUse);
  optional('Documents deleted', t.documentsGone);
  optional('Documents not reached', t.documentsNotReached);
  rows.push(['Sentences written in', t.sentences]);
  optional('Translations filled', t.translations);
  optional('Translations of the job revised', t.refreshed);
  optional('Words analyzed', t.words);
  optional('Lexicon links made', t.links);
  optional('Entries created', t.entries);
  optional('Changes proposed', t.proposed);
  optional('Sentences skipped as too long', t.skippedTooLong);
  optional('Sentences skipped as failed', t.skippedFailed);
  optional('Sentences skipped as changed during the job', t.skippedChanged);
  optional('Sentences skipped after an interrupted write', t.skippedInterrupted);
  optional('Sentences skipped and not listed', t.skippedMore);
  optional('Changes not written, sentence changed meanwhile', t.changed);
  return rows.map(([label, n]) => [label, (n ?? 0).toLocaleString()]);
};

const Analysis = ({ text, count }) => (
  <span className="whitespace-nowrap">
    {text}
    {count !== undefined && <span className="text-muted-foreground"> ×{count}</span>}
  </span>
);

const EntryLine = ({ entry }) => (
  <li>
    {entry.form}
    {entry.gloss ? ` ‘${entry.gloss}’` : ''}
  </li>
);

// The changes the job staged and did not apply (the apply rule), each where
// it is, from what to what, and the note of the piece that staged it: what a
// person approves in a conversation with the assistant about the job.
const ProposedChanges = ({ report, projectId }) => {
  const list = report.proposed || [];
  const more = report.proposedMore || 0;
  if (!list.length && !more) return null;
  return (
    <>
      <Heading section="proposed" />
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

// Each piece's note, as the model ended it.
const PieceNotes = ({ report }) => {
  const notes = report.notes || [];
  if (!notes.length && !(report.notesMore > 0)) return null;
  return (
    <>
      <Heading section="notes" />
      <ul className="ml-4 list-disc text-sm">
        {notes.map((n, i) => (
          <li key={i} dir="auto">
            {(n.name || n.sentences) && (
              <span className="text-muted-foreground">
                {[n.name, n.sentences].filter(Boolean).join(' ')}:{' '}
              </span>
            )}
            {n.note}
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

export const JobReport = ({ report, projectId, vocabs = [] }) => {
  const paused = [
    ['Paused for people', report.pausedForPeopleS],
    ['Waiting for the model', report.pausedForModelS],
  ].filter(([, s]) => s > 0);
  const skipped = (report.documents || []).filter((d) => d.skipped?.length);
  const blank = (report.documents || []).filter((d) => d.left?.length || d.leftMore > 0);
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

  return (
    <section aria-label="Report">
      <h2 className={`${TYPE.section} mt-8`}>Report</h2>
      {report.stopped === 'without-worker' && (
        <p className="mt-2 text-sm text-muted-foreground">Stopped with no worker running.</p>
      )}
      {report.summary && (
        <div
          className="mt-3 max-w-2xl whitespace-pre-wrap text-sm"
          dir="auto"
          data-testid="job-summary"
        >
          {report.summary}
        </div>
      )}
      {report.summaryFailed && (
        <p className="mt-2 text-sm text-muted-foreground">The summary could not be written.</p>
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

      <LeftOut report={report} projectId={projectId} />
      <ProposedChanges report={report} projectId={projectId} />
      <PieceNotes report={report} />
      <Tables tables={report.tables || []} more={report.tablesMore || 0} />

      {skipped.length > 0 && (
        <>
          <Heading section="skipped" />
          {skipped.map((d) => (
            <div key={d.documentId} className="mb-3 text-sm">
              <p className="font-medium">{d.name ?? 'Deleted document'}</p>
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
                  And {d.counts.skippedMore.toLocaleString()} more
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
              <p className="font-medium">{d.name ?? 'Deleted document'}</p>
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
                    <span className="text-muted-foreground">{l.form ?? 'Translation'}</span>
                  </li>
                ))}
              </ul>
              {d.leftMore > 0 && (
                <p className="ml-4 text-muted-foreground">And {d.leftMore.toLocaleString()} more</p>
              )}
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
