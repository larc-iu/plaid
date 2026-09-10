import { FileText, Quote } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ContextRow } from './DictionaryPanels';
import { sentenceTo } from './vocabConcordance';

// The Concordance tab: the open entry's uses, grouped by document, each row
// a link into the sentence, with "Use as example" for a maintainer. `conc` is
// a useItemConcordance.
export const ConcordancePanel = ({ conc, selectedItem, canManage, onAddExample }) => {
  const {
    concPlan,
    concGroups,
    concLoaded,
    concLoading,
    concLoadingMore,
    concError,
    concHasMore,
    loadMore,
    sentinelRef,
  } = conc;
  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <span className="text-sm font-medium">Concordance</span>
        {concPlan && (
          <span className="text-xs text-muted-foreground">
            {concPlan.totalHits.toLocaleString()} use
            {concPlan.totalHits === 1 ? '' : 's'} in {concPlan.totalDocs} document
            {concPlan.totalDocs === 1 ? '' : 's'}
            {concPlan.truncated ? ' (capped)' : ''}
          </span>
        )}
      </div>

      {concLoading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted border-t-foreground" />
          Loading usage examples…
        </div>
      ) : concError ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">{concError}</p>
      ) : !concPlan || concPlan.totalHits === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-muted-foreground">
          Not linked to any words or morphemes yet.
        </p>
      ) : (
        <div className="flex flex-col gap-3 p-3">
          {concGroups.map((g) => (
            <div key={g.docId} className="overflow-hidden rounded-md border">
              <div className="flex items-center gap-2 border-b bg-muted/50 px-3 py-1.5">
                <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-sm font-medium">{g.docName}</span>
                <span className="text-xs text-muted-foreground">
                  {g.docHits} use{g.docHits === 1 ? '' : 's'}
                </span>
              </div>
              <div className="divide-y">
                {g.rows.map((row) => {
                  // Deep-link the target sentence via query params, so the row
                  // is an ordinary link: a new tab lands on the same sentence.
                  const tokenId = row.tokenIds?.[0];
                  const chosen =
                    !!tokenId &&
                    (selectedItem?.metadata?.examples || []).some(
                      (ex) => ex?.document === g.docId && ex?.token === tokenId,
                    );
                  return (
                    <div key={row.sentenceId} className="group flex items-start">
                      <ContextRow row={row} to={sentenceTo(g.projectId, g.docId, row.sentenceId)} />
                      {canManage && tokenId && (
                        <button
                          type="button"
                          disabled={chosen}
                          onClick={() => onAddExample(g.docId, tokenId)}
                          className={cn(
                            'mr-2 mt-1.5 inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:opacity-100',
                            chosen
                              ? 'opacity-60'
                              : 'opacity-0 group-hover:opacity-100 disabled:opacity-30',
                          )}
                        >
                          <Quote className="h-3 w-3" />
                          {chosen ? 'Example' : 'Use as example'}
                        </button>
                      )}
                    </div>
                  );
                })}
                {g.rows.length === 0 && (
                  <p className="px-3 py-2 text-xs text-muted-foreground">
                    Uses in this document could not be located (it may have changed). Open it to
                    look.
                  </p>
                )}
              </div>
            </div>
          ))}

          {concHasMore && (
            <div ref={sentinelRef} className="flex justify-center py-2">
              <Button variant="outline" size="sm" onClick={loadMore} disabled={concLoadingMore}>
                {concLoadingMore
                  ? 'Loading…'
                  : `Load more (${(concPlan.totalDocs - concLoaded).toLocaleString()} document${concPlan.totalDocs - concLoaded === 1 ? '' : 's'} left)`}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
