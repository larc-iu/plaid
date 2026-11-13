import { useMemo, useState } from 'react';
import { Button } from '@ui/components/ui/button';
import { Loading } from '@ui/components/shared/Loading.jsx';
import { Notice } from '@ui/components/shared/Notice.jsx';
import { SegmentedControl } from '@ui/components/shared/SegmentedControl.jsx';
import { countOf } from '@ui/lib/plural.js';
import { TYPE } from '@ui/lib/typeScale.js';
import { documentRowChanges, entryChanges, sentenceChanges } from '@/domain/historyChanges.js';
import { getIgtLayerInfo } from '@/domain/layerInfo.js';
import { SentenceChange } from './SentenceChange.jsx';
import { EntryChangeList } from './EntryChangeList.jsx';
import { ChangeValue } from './ChangeValue.jsx';
import { countLine } from './changeMarks.js';
import { useChangeRows } from './useChangeRows.js';

/**
 * What a History entry changed in this document, the default view of a whole
 * entry (the shell's `historyChanges`): each sentence it changed, in reading
 * order, before and after; then the document's name and metadata, the
 * lexicon entries it created, changed, merged or deleted, and what it changed
 * outside the sentences. A count over it says how many changes, and how many
 * replaced a person's value, which a switch shows alone.
 *
 * Read from core a page at a time (useChangeRows): this document's rows, and
 * each of its vocabularies' entry rows. The sentences are placed in the
 * document as of the entry's end (`historySnapshot`), which the shell reads
 * for the entry anyway.
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

  // A first page that failed is said above, and shows nothing.
  const docRows = useMemo(
    () => data.rows.document ?? (data.loading ? undefined : []),
    [data.rows.document, data.loading],
  );
  const entryRows = useMemo(
    () => streams.slice(1).flatMap((s) => data.rows[s.key] || []),
    [streams, data.rows],
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

  if (!view) return <Loading label="Loading changes…" />;
  const errors = Object.values(data.errors);
  const persons = only === 'persons';
  const sentences = persons ? view.sentences.filter((s) => s.replaced > 0) : view.sentences;
  const dir = after.textDirection;

  return (
    <div className="flex flex-col gap-4 pt-2" data-testid="history-changes">
      {errors.map((e) => (
        <Notice key={e} tone="error">
          {e}
        </Notice>
      ))}
      {view.changes === 0 && !data.more ? (
        <p className="text-sm text-muted-foreground">No changes to show.</p>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm" data-testid="change-count">
            {countLine(view.changes, view.replaced, data.more)}
          </p>
          <SegmentedControl
            label="Filter"
            value={only}
            onChange={setOnly}
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

      {data.more && (
        <div>
          <Button variant="outline" size="sm" onClick={data.loadMore} disabled={data.loading}>
            {data.loading ? 'Loading…' : 'Show more changes'}
          </Button>
        </div>
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
