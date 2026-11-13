import { useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '@ui/components/ui/button';
import { Loading } from '@ui/components/shared/Loading.jsx';
import { Notice } from '@ui/components/shared/Notice.jsx';
import { SegmentedControl } from '@ui/components/shared/SegmentedControl.jsx';
import { countOf } from '@ui/lib/plural.js';
import { TYPE } from '@ui/lib/typeScale.js';
import { documentViewSearch } from '@ui/hooks/useHistoryParam.js';
import { documentRowChanges, entryChanges, sentenceChanges } from '@/domain/historyChanges.js';
import { getIgtLayerInfo } from '@/domain/layerInfo.js';
import { SentenceChange } from './SentenceChange.jsx';
import { EntryChangeList } from './EntryChangeList.jsx';
import { ChangeValue } from './ChangeValue.jsx';
import { countLine } from './changeMarks.js';
import { CHANGE_ROWS_CEILING, useChangeRows } from './useChangeRows.js';

// How many sentences are drawn at once. Every row is read before any is
// drawn, and drawing is what a long entry pages.
export const SENTENCES_SHOWN = 50;

/**
 * What a History entry changed in this document, the default view of a whole
 * entry (the shell's `historyChanges`): each sentence it changed, in reading
 * order, before and after; then the document's name and metadata, the
 * lexicon entries it created, changed, merged or deleted, and what it changed
 * outside the sentences. A count over it says how many changes, and how many
 * replaced a person's value, which a switch shows alone.
 *
 * Read whole from core before anything is drawn (useChangeRows): this
 * document's rows, and each of its vocabularies' entry rows, since a page of
 * them can hold a text edit's shifted tokens without its text. The sentences
 * are placed in the document as of the entry's end (`historySnapshot`), which
 * the shell reads for the entry anyway, and drawn SENTENCES_SHOWN at a time.
 * An entry past CHANGE_ROWS_CEILING rows is not drawn: it says so, with a link
 * to the document as of it.
 */
export const DocumentHistoryChanges = ({ context }) => {
  const { client, projectId, documentId, pastEntry, historySnapshot: after } = context;
  const vocabIds = Object.keys(after?.vocabularies || {}).sort();
  const vocabKey = vocabIds.join(',');
  const streams = useMemo(
    () => [
      { key: 'document', opts: { documentId } },
      ...(vocabKey ? vocabKey.split(',') : []).map((id) => ({
        key: `vocab:${id}`,
        opts: { vocabLayerId: id },
      })),
    ],
    [documentId, vocabKey],
  );
  const data = useChangeRows(client, after ? pastEntry.id : null, streams);
  const [only, setOnly] = useState('all');
  const [shown, setShown] = useState(SENTENCES_SHOWN);
  const { search } = useLocation();
  const errors = Object.values(data.errors);
  const whole = !data.reading && !errors.length && !Object.keys(data.over).length;

  const docRows = whole ? data.rows.document : null;
  const entryRows = useMemo(
    () => (whole ? streams.slice(1).flatMap((s) => data.rows[s.key] || []) : null),
    [whole, streams, data.rows],
  );
  const view = useMemo(() => {
    if (!after || !docRows) return null;
    const { sentences, unplaced } = sentenceChanges(
      { raw: after.raw, vocabularies: after.vocabularies },
      docRows,
    );
    const entries = entryChanges(
      [...entryRows, ...docRows.filter((r) => r.kind === 'vocab-link')],
      after.vocabularies,
    );
    const documentFields = documentRowChanges(docRows);
    const transcriptLayer = getIgtLayerInfo(after.raw).alignmentTokenLayer?.id;
    const transcript = unplaced.filter((r) => r.layer && r.layer === transcriptLayer).length;
    const other = unplaced.length - transcript;
    const changes =
      sentences.reduce((n, s) => n + s.changes, 0) +
      entries.length +
      documentFields.length +
      unplaced.length;
    const replaced = sentences.reduce((n, s) => n + s.replaced, 0);
    return { sentences, entries, documentFields, transcript, other, changes, replaced };
  }, [after, docRows, entryRows]);

  if (!after) return <Loading label="Loading changes…" />;
  if (data.reading) {
    return (
      <Loading label={`Reading changes, ${data.read.toLocaleString()} so far`} className="pt-2" />
    );
  }
  if (errors.length) {
    return (
      <div className="flex flex-col gap-2 pt-2" data-testid="history-changes">
        {errors.map((e) => (
          <Notice key={e} tone="error">
            {e}
          </Notice>
        ))}
      </div>
    );
  }
  if (!view) {
    return (
      <div className="flex flex-col items-start gap-2 pt-2" data-testid="history-changes">
        <p className="text-sm" data-testid="change-count">
          More than {CHANGE_ROWS_CEILING.toLocaleString()} changes.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link to={{ search: documentViewSearch(search) }}>Show document</Link>
        </Button>
      </div>
    );
  }
  const persons = only === 'persons';
  const picked = persons ? view.sentences.filter((s) => s.replaced > 0) : view.sentences;
  const sentences = picked.slice(0, shown);
  const dir = after.textDirection;

  return (
    <div className="flex flex-col gap-4 pt-2" data-testid="history-changes">
      {view.changes === 0 ? (
        <p className="text-sm text-muted-foreground">No changes to show.</p>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm" data-testid="change-count">
            {countLine(view.changes, view.replaced)}
          </p>
          <SegmentedControl
            label="Filter"
            value={only}
            onChange={(next) => {
              setOnly(next);
              setShown(SENTENCES_SHOWN);
            }}
            options={[
              { value: 'all', label: 'All changes' },
              { value: 'persons', label: 'A person’s value replaced', count: view.replaced },
            ]}
          />
        </div>
      )}
      {view.changes > 0 && <Legend />}

      {sentences.map((s) => (
        <SentenceChange key={s.id} s={s} dir={dir} projectId={projectId} documentId={documentId} />
      ))}
      {picked.length > shown && (
        <div>
          <Button variant="outline" size="sm" onClick={() => setShown((n) => n + SENTENCES_SHOWN)}>
            Show more sentences
          </Button>
        </div>
      )}

      {!persons && view.documentFields.length > 0 && (
        <section>
          <h3 className={`${TYPE.card} mb-2`}>Document</h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            {view.documentFields.map((f) => (
              <div key={f.label} className="contents">
                <dt className="text-xs text-muted-foreground">{f.label}</dt>
                <dd className="font-text" dir="auto">
                  <ChangeValue c={{ ...f, changed: true, replaced: false }} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {!persons && view.entries.length > 0 && (
        <section>
          <h3 className={`${TYPE.card} mb-2`}>Lexicon</h3>
          <EntryChangeList entries={view.entries} entryId={pastEntry.id} />
        </section>
      )}

      {!persons && (view.transcript > 0 || view.other > 0) && (
        <ul className="text-sm text-muted-foreground">
          {view.transcript > 0 && (
            <li>{countOf(view.transcript, 'change')} to transcript segments</li>
          )}
          {view.other > 0 && <li>{countOf(view.other, 'change')} to other annotations</li>}
        </ul>
      )}
    </div>
  );
};

// The marks of the old and new values, in the grid legend's words.
const Legend = () => (
  <p className="text-xs text-muted-foreground">
    New over old. Marks: <span className="plaid-prov--machine">machine-made</span> ·{' '}
    <span className="plaid-prov--contributed">contributed</span> ·{' '}
    <span className="underline decoration-[var(--plaid-machine-soft)] underline-offset-[3px]">
      confirmed
    </span>{' '}
    · plain: a person’s · <del className="text-destructive-strong">red</del>: a person’s value
    replaced
  </p>
);
