import { Link } from 'react-router-dom';
import { TYPE } from '@ui/lib/typeScale.js';
import { plural } from '@ui/lib/plural.js';
import { APP_ROUTES } from '@/appRoutes.js';
import { HARMONIZE_BY_TEXT, HARMONIZE_LEFT_TEXT, durationText, skippedText } from './jobText.js';

// A finished job's report (CONTRACT 5.3, as the client hands it over, keys in
// camelCase): the totals, each document's skipped sentences, what harmonize
// changed and left, and the entries the job made, deleted or left unlinked.
// Every list the worker cut says how many it left out.

const Heading = ({ children }) => <h3 className={`${TYPE.card} mb-2 mt-6`}>{children}</h3>;

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
  const tasks = report.tasks || [];
  const rows = [['Documents done', t.documentsDone]];
  const optional = (label, n) => n > 0 && rows.push([label, n]);
  optional('Documents in use', t.documentsInUse);
  optional('Documents deleted', t.documentsGone);
  optional('Documents not reached', t.documentsNotReached);
  rows.push(['Sentences analyzed', t.sentences]);
  if (tasks.includes('translate')) {
    rows.push(['Translations filled', t.translations]);
    rows.push(['Machine translations replaced', t.refreshed]);
  }
  if (tasks.includes('gloss')) rows.push(['Words analyzed', t.words]);
  if (tasks.includes('link')) {
    rows.push(['Lexicon links made', t.links]);
    rows.push(['Entries created', t.entries]);
  }
  optional('Sentences skipped as too long', t.skippedTooLong);
  optional('Sentences skipped as failed', t.skippedFailed);
  optional('Sentences skipped as changed during the job', t.skippedChanged);
  optional('Changes not written, sentence changed meanwhile', t.changed);
  optional('Changes not written, a person’s work', t.protected);
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

export const JobReport = ({ report, projectId, vocabs = [] }) => {
  const paused = [
    ['Paused for people', report.pausedForPeopleS],
    ['Waiting for the model', report.pausedForModelS],
  ].filter(([, s]) => s > 0);
  const skipped = (report.documents || []).filter((d) => d.skipped?.length);
  const harmonize = report.harmonize || {};
  const entries = report.entries || {};
  const changed = harmonize.changed || [];
  const left = harmonize.left || [];
  const linked = (report.tasks || []).includes('link');
  // The project's lexicons the job created entries in, in the project's order.
  const madeIn = new Set(entries.lexicons || []);
  const draftLexicons = vocabs.filter((v) => madeIn.has(v.id));

  return (
    <section aria-label="Report">
      <h2 className={`${TYPE.section} mt-8`}>Report</h2>
      {report.stopped === 'without-worker' && (
        <p className="mt-2 text-sm text-muted-foreground">Stopped with no worker running.</p>
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

      {skipped.length > 0 && (
        <>
          <Heading>Skipped sentences</Heading>
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
            </div>
          ))}
        </>
      )}

      {(changed.length > 0 || harmonize.changedMore > 0) && (
        <>
          <Heading>Analyses made consistent</Heading>
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
          <Heading>Forms left inconsistent</Heading>
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

      {linked && (
        <>
          <Heading>Entries</Heading>
          {[
            ['Created', entries.created, entries.createdMore],
            ['Deleted as unlinked', entries.deleted, entries.deletedMore],
            ['Machine drafts with no links', entries.unlinked, entries.unlinkedMore],
          ].map(([label, list = [], more = 0]) =>
            list.length || more ? (
              <div key={label} className="mb-3 text-sm">
                <p className="font-medium">{label}</p>
                <ul className="ml-4 list-disc">
                  {list.map((e) => (
                    <EntryLine key={e.id} entry={e} />
                  ))}
                </ul>
                <More n={more} noun="entry" />
              </div>
            ) : null,
          )}
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
    </section>
  );
};
