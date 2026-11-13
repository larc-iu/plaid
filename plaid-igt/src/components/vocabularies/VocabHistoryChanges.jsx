import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '@ui/components/ui/button';
import { Loading } from '@ui/components/shared/Loading.jsx';
import { Notice } from '@ui/components/shared/Notice.jsx';
import { countOf } from '@ui/lib/plural.js';
import { TYPE } from '@ui/lib/typeScale.js';
import { documentViewSearch, historyHref } from '@ui/hooks/useHistoryParam.js';
import { entryChanges, linkCounts } from '@/domain/historyChanges.js';
import { APP_ROUTES } from '@/appRoutes.js';
import { EntryChangeList } from '../documents/history/EntryChangeList.jsx';
import { CHANGE_ROWS_CEILING, useChangeRows } from '../documents/history/useChangeRows.js';

// How many documents the links list names, of an entry that moved links in
// more (a merge of a common entry reaches every document of a corpus).
const LINK_DOCUMENTS_SHOWN = 50;

/**
 * What a History entry of a vocabulary changed, the default view of a whole
 * entry: the vocabulary's entries it created, changed, merged or deleted,
 * before and after, by the vocabulary's own field names, and the links it
 * moved, removed or made for them, counted per document, each document a
 * link to its own History at this entry. `past` is the vocabulary as of the
 * entry's end (`{time, vocabulary}`, useVocabHistory), which names entries.
 *
 * Both reads are read whole before anything is drawn (useChangeRows): the
 * vocabulary's own rows (`?vocab-layer-id=`), its entries and itself, and the
 * whole entry's for the links, since a link is a document's row and the
 * vocabulary's read leaves links out. Past CHANGE_ROWS_CEILING rows, the
 * entries are not drawn (a link to the vocabulary as of the entry instead),
 * and the links not counted.
 */
export const VocabHistoryChanges = ({ client, vocabularyId, entry, past }) => {
  const streams = useMemo(
    () => [
      { key: 'own', opts: { vocabLayerId: vocabularyId } },
      { key: 'all', opts: {} },
    ],
    [vocabularyId],
  );
  const data = useChangeRows(client, past ? entry.id : null, streams);
  const { search } = useLocation();
  const errors = Object.values(data.errors);
  const done = !data.reading && !errors.length && !data.over.own;
  const view = useMemo(() => {
    if (!past || !done) return null;
    const vocabularies = { [vocabularyId]: past.vocabulary };
    const own = data.rows.own;
    const links = data.rows.all.filter((r) => r.kind === 'vocab-link');
    const mine = [...own.filter((r) => r.kind === 'vocab-item'), ...links];
    const self = own.find((r) => r.kind === 'vocab-layer' && r.id === vocabularyId);
    const settings = [];
    if (self?.before && self?.after) {
      if ((self.before.name ?? '') !== (self.after.name ?? '')) {
        settings.push({
          label: 'Name',
          before: self.before.name ?? '',
          after: self.after.name ?? '',
        });
      }
      if (JSON.stringify(self.before.config ?? {}) !== JSON.stringify(self.after.config ?? {})) {
        settings.push({ label: 'Settings', before: '', after: 'Changed' });
      }
    }
    return {
      entries: entryChanges(mine, vocabularies),
      links: data.over.all ? null : linkCounts(links, vocabularyId),
      settings,
    };
  }, [past, done, data.rows, data.over.all, vocabularyId]);

  const shownDocs = useMemo(
    () => (view?.links || []).slice(0, LINK_DOCUMENTS_SHOWN).map((c) => c.documentId),
    [view],
  );
  const docs = useDocumentNames(client, shownDocs);

  if (!past) return <Loading label="Loading changes…" />;
  if (data.reading) {
    return <Loading label={`Reading changes, ${data.read.toLocaleString()} so far`} />;
  }
  if (errors.length) {
    return (
      <div className="flex flex-col gap-2" data-testid="history-changes">
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
      <div className="flex flex-col items-start gap-2" data-testid="history-changes">
        <p className="text-sm" data-testid="change-count">
          More than {CHANGE_ROWS_CEILING.toLocaleString()} changes.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link to={{ search: documentViewSearch(search) }}>Show vocabulary</Link>
        </Button>
      </div>
    );
  }
  const links = view.links || [];
  const linkTotal = links.reduce((n, c) => n + c.moved + c.removed + c.made, 0);
  const nothing = !view.entries.length && !links.length && !view.settings.length && !!view.links;

  return (
    <div className="flex flex-col gap-4" data-testid="history-changes">
      {nothing ? (
        <p className="text-sm text-muted-foreground">No changes to show.</p>
      ) : (
        <p className="text-sm" data-testid="change-count">
          {countOf(view.entries.length, 'entry', 'entries')}
          {linkTotal > 0 &&
            `, ${countOf(linkTotal, 'link')} in ${countOf(links.length, 'document')}`}
        </p>
      )}

      {view.settings.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          {view.settings.map((f) => (
            <div key={f.label} className="contents">
              <dt className="text-xs text-muted-foreground">{f.label}</dt>
              <dd dir="auto">
                {f.before && <del className="me-2 text-muted-foreground">{f.before}</del>}
                {f.after}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {view.entries.length > 0 && <EntryChangeList entries={view.entries} entryId={entry.id} />}

      {!view.links && (
        <section>
          <h3 className={`${TYPE.card} mb-2`}>Links</h3>
          <p className="text-sm text-muted-foreground" data-testid="link-counts">
            Not counted: more than {CHANGE_ROWS_CEILING.toLocaleString()} changes in documents.
          </p>
        </section>
      )}

      {links.length > 0 && (
        <section>
          <h3 className={`${TYPE.card} mb-2`}>Links</h3>
          <table className="text-sm" data-testid="link-counts">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1 pr-6 font-medium">Document</th>
                <th className="py-1 pr-6 text-right font-medium">Moved</th>
                <th className="py-1 pr-6 text-right font-medium">Removed</th>
                <th className="py-1 text-right font-medium">Made</th>
              </tr>
            </thead>
            <tbody>
              {links.slice(0, LINK_DOCUMENTS_SHOWN).map((c) => {
                const doc = docs[c.documentId];
                return (
                  <tr key={c.documentId} className="border-t" data-document={c.documentId}>
                    <td className="py-1 pr-6">
                      {doc ? (
                        <Link
                          className="font-text hover:underline"
                          dir="auto"
                          to={historyHref(APP_ROUTES.document(doc.project, c.documentId), entry.id)}
                        >
                          {doc.name}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">Document</span>
                      )}
                    </td>
                    <td className="py-1 pr-6 text-right tabular-nums">{c.moved || ''}</td>
                    <td className="py-1 pr-6 text-right tabular-nums">{c.removed || ''}</td>
                    <td className="py-1 text-right tabular-nums">{c.made || ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {links.length > LINK_DOCUMENTS_SHOWN && (
            <p className="mt-1 text-sm text-muted-foreground">
              And {countOf(links.length - LINK_DOCUMENTS_SHOWN, 'more document')}.
            </p>
          )}
        </section>
      )}
    </div>
  );
};

// The name and project of each document in `ids`, read once each (a short
// read, no body). A document that cannot be read stays unnamed.
const useDocumentNames = (client, ids) => {
  const [names, setNames] = useState({});
  const key = ids.join(',');
  useEffect(() => {
    let live = true;
    const wanted = key ? key.split(',') : [];
    Promise.all(
      wanted.map((id) =>
        client.documents.get(id).then(
          (d) => [id, { name: d?.name ?? '', project: d?.project }],
          () => [id, null],
        ),
      ),
    ).then((pairs) => {
      if (live) setNames((prev) => ({ ...prev, ...Object.fromEntries(pairs) }));
    });
    return () => {
      live = false;
    };
  }, [client, key]);
  return names;
};
