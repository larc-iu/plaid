import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { ListCount, ListPager, SearchInput, SortHeader } from '@/components/ui/list-search';
import { notifySuccess, notifyError, notifyWarning, humanizeError } from '@/utils/feedback';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { pageKey, usePagedList } from '@/hooks/usePagedList';
import { listPrefKey, useStickySort } from '@/hooks/useStickyState';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { getIgtLayerInfo } from '@/domain/layerInfo';
import { findBaselineTextLayer } from '@/domain/igtConfig';
import { timeAgo, fullTimestamp } from '@/utils/formatTime';

// The columns this list sorts by, named once so a remembered sort on a column
// that is no longer here is rejected rather than reaching the comparator.
const DOCUMENT_COLUMNS = ['name', 'words', 'updated', 'mine'];

export const DocumentList = ({
  documents,
  project,
  projectId,
  client,
  canManage,
  canWrite = true,
  onDocumentCreated,
}) => {
  const [open, setOpen] = useState(false);
  const [documentName, setDocumentName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  // documentId -> word count. Docs with a word layer but no tokens are absent
  // (rendered 0); `hasWordLayer` false means the project has no primary token layer.
  const [wordCounts, setWordCounts] = useState({});
  const [hasWordLayer, setHasWordLayer] = useState(true);
  const [wordsLoading, setWordsLoading] = useState(true);
  // documentId -> when THIS reader last wrote to it. Absent means never, which
  // is a fact about them and not a gap in the data, so the cell reads as a dash
  // rather than a spinner once the read has landed.
  const [myLastEdits, setMyLastEdits] = useState({});
  const [mineLoading, setMineLoading] = useState(true);
  const [sort, onSort] = useStickySort(
    listPrefKey('sort', 'documents', projectId),
    { key: 'updated', dir: 'desc' },
    DOCUMENT_COLUMNS,
  );
  const [filter, setFilter] = useState('');

  // Per-document word counts: one aggregate query over the project's primary
  // (word) token-layer tokens, grouped by document. Morphemes are sub-word units
  // and shouldn't inflate the word count, so we count the primary layer only.
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    (async () => {
      setWordsLoading(true);
      const wordLayerId = getIgtLayerInfo(project).primaryTokenLayer?.id;
      if (!wordLayerId || !client) {
        if (!cancelled) {
          setHasWordLayer(false);
          setWordCounts({});
          setWordsLoading(false);
        }
        return;
      }
      try {
        const res = await client.query({
          where: [['token', '?t', { layer: wordLayerId, doc: { var: '?d' } }]],
          return: { group: ['?d'], aggregates: [['count']] },
        });
        const byDoc = {};
        for (const [docId, n] of res?.results || []) byDoc[docId] = n;
        if (!cancelled) {
          setHasWordLayer(true);
          setWordCounts(byDoc);
        }
      } catch (err) {
        console.error('Word-count query failed:', err);
        if (!cancelled) {
          setHasWordLayer(false);
          setWordCounts({});
          notifyWarning(
            'Word counts could not be loaded for the document list.',
            'Word counts unavailable',
          );
        }
      } finally {
        if (!cancelled) setWordsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project, client]);

  // When this reader last touched each document, from the audit log in one
  // request. A failure here costs a column, not the list, so it warns and
  // leaves every cell empty.
  useEffect(() => {
    if (!client || !projectId) return;
    let cancelled = false;
    (async () => {
      setMineLoading(true);
      try {
        const edits = await client.projects.myLastEdits(projectId);
        if (!cancelled) setMyLastEdits(edits || {});
      } catch (err) {
        console.error('Last-edited query failed:', err);
        if (!cancelled) {
          setMyLastEdits({});
          notifyWarning(
            'Your last edit could not be loaded for the document list.',
            'Column unavailable',
          );
        }
      } finally {
        if (!cancelled) setMineLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, client]);

  const navigate = useNavigate();

  const handleCreateDocument = async () => {
    if (!documentName.trim()) {
      notifyError('Document name is required', 'Error');
      return;
    }
    setIsCreating(true);
    try {
      if (!client) throw new Error('Authentication required');
      const newDocument = await client.documents.create(projectId, documentName.trim());
      const projectData = await client.projects.get(projectId);
      const primaryTextLayer = findBaselineTextLayer(projectData?.textLayers);
      if (primaryTextLayer) {
        await client.texts.create(primaryTextLayer.id, newDocument.id, '', {});
      }
      notifySuccess(`Document "${documentName}" created`, 'Success');
      setDocumentName('');
      setOpen(false);
      if (onDocumentCreated) onDocumentCreated({ ...newDocument, name: documentName.trim() });
      // A new document is empty, so the next thing to do is type its text.
      navigate(`/projects/${projectId}/documents/${newDocument.id}?tab=baseline`);
    } catch (error) {
      console.error('Failed to create document:', error);
      notifyError(humanizeError(error, 'Could not create the document.'), 'Error');
    } finally {
      setIsCreating(false);
    }
  };

  const sortedDocuments = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matched = q
      ? documents.filter((d) => (d.name || '').toLowerCase().includes(q))
      : documents;
    const extract = {
      name: (d) => d.name?.toLowerCase() ?? '',
      words: (d) => (hasWordLayer ? (wordCounts[d.id] ?? 0) : -1),
      updated: (d) => (d.timeModified ? new Date(d.timeModified).getTime() : 0),
      // Never touched sorts as the oldest, so descending puts the documents
      // this reader has actually worked on at the top.
      mine: (d) => (myLastEdits[d.id] ? new Date(myLastEdits[d.id]).getTime() : 0),
    }[sort.key];
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...matched].sort((a, b) => {
      const av = extract(a);
      const bv = extract(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [documents, wordCounts, hasWordLayer, myLastEdits, sort, filter]);

  const paged = usePagedList(sortedDocuments, {
    resetKey: `${filter}|${sort.key}|${sort.dir}`,
    storageKey: pageKey('documents', projectId),
  });

  const renderWords = (documentId) => {
    if (wordsLoading) {
      return (
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-primary align-middle" />
      );
    }
    if (!hasWordLayer) return '—';
    return (wordCounts[documentId] ?? 0).toLocaleString();
  };

  const renderMine = (documentId) => {
    if (mineLoading) {
      return (
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-primary align-middle" />
      );
    }
    const at = myLastEdits[documentId];
    if (!at) return '—';
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>{timeAgo(at) || '—'}</span>
        </TooltipTrigger>
        <TooltipContent>{fullTimestamp(at)}</TooltipContent>
      </Tooltip>
    );
  };

  return (
    <div className="tw mt-2">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold">Documents</h2>
        <div className="flex items-center gap-2">
          <SearchInput
            className="w-56"
            placeholder="Search documents…"
            value={filter}
            onChange={setFilter}
          />
          {documents.length > 0 && (
            <ListCount shown={sortedDocuments.length} total={documents.length} noun="document" />
          )}
          {canWrite && (
            <Button onClick={() => setOpen(true)}>
              <Plus className="h-4 w-4" /> New Document
            </Button>
          )}
        </div>
      </div>

      {documents.length === 0 ? (
        <div className="rounded-md border py-12 text-center text-muted-foreground">
          <p className="text-base">No documents yet.</p>
        </div>
      ) : sortedDocuments.length === 0 ? (
        <div className="rounded-md border py-12 text-center text-muted-foreground">
          <p className="text-base">No documents match “{filter.trim()}”.</p>
        </div>
      ) : (
        <TooltipProvider>
          <div className="overflow-hidden rounded-md border">
            <ListPager {...paged} onPage={paged.setPage} position="top" />
            {/* table-fixed + colgroup: with `auto` layout the name column's
                intrinsic width is the full untruncated title, so one long name
                pushed the table past its wrapper and `overflow-hidden` clipped
                Words and Updated out of view. Fixed layout hands the two narrow
                columns their width first and lets the name wrap into whatever
                is left. */}
            <table className="w-full table-fixed text-sm">
              <colgroup>
                <col />
                <col className="w-[88px]" />
                <col className="w-[160px]" />
                <col className="w-[150px]" />
              </colgroup>
              <thead className="border-b bg-muted/40">
                <tr>
                  <th className="px-4 py-2 text-left">
                    <SortHeader field="name" label="Document" sort={sort} onSort={onSort} />
                  </th>
                  <th className="px-4 py-2 text-right">
                    <SortHeader
                      field="words"
                      label="Words"
                      sort={sort}
                      onSort={onSort}
                      className="justify-end"
                    />
                  </th>
                  <th className="px-4 py-2 text-right">
                    <SortHeader
                      field="updated"
                      label="Updated"
                      sort={sort}
                      onSort={onSort}
                      className="justify-end"
                    />
                  </th>
                  <th className="px-4 py-2 text-right">
                    <SortHeader
                      field="mine"
                      label="Your last edit"
                      sort={sort}
                      onSort={onSort}
                      className="justify-end"
                    />
                  </th>
                </tr>
              </thead>
              <tbody>
                {paged.pageItems.map((d) => {
                  // Each cell wraps its content in a real <a> (rather than a row
                  // onClick) so the row behaves as a true link: middle-click and
                  // right-click → "open in new tab" work natively. Tailwind
                  // preflight (scoped to .tw) resets anchor color/underline.
                  const href = `#/projects/${projectId}/documents/${d.id}`;
                  return (
                    <tr key={d.id} className="border-b last:border-0 hover:bg-accent/40">
                      <td className="p-0">
                        <a href={href} className="block px-4 py-3">
                          <div className="min-w-0">
                            {/* Wrap rather than truncate: a long title is the
                                only thing distinguishing two recordings, so
                                hiding its tail is worse than a taller row.
                                break-words so a single very long token still
                                cannot force the column wider. */}
                            <div className="break-words font-medium">{d.name}</div>
                            <div className="truncate text-xs text-muted-foreground">ID: {d.id}</div>
                          </div>
                        </a>
                      </td>
                      <td className="p-0">
                        <a
                          href={href}
                          className="block px-4 py-3 text-right tabular-nums text-muted-foreground"
                        >
                          {renderWords(d.id)}
                        </a>
                      </td>
                      <td className="p-0">
                        <a
                          href={href}
                          className="block whitespace-nowrap px-4 py-3 text-right text-muted-foreground"
                        >
                          {d.timeModified ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span>{timeAgo(d.timeModified) || '—'}</span>
                              </TooltipTrigger>
                              <TooltipContent>{fullTimestamp(d.timeModified)}</TooltipContent>
                            </Tooltip>
                          ) : (
                            '—'
                          )}
                        </a>
                      </td>
                      <td className="p-0">
                        <a
                          href={href}
                          className="block whitespace-nowrap px-4 py-3 text-right text-muted-foreground"
                        >
                          {renderMine(d.id)}
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <ListPager {...paged} onPage={paged.setPage} />
          </div>
        </TooltipProvider>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New document</DialogTitle>
            <DialogDescription>
              Name the document; you can add its text on the Baseline tab afterwards.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="doc-name">Document Name</Label>
            <Input
              id="doc-name"
              placeholder="Enter document name"
              value={documentName}
              onChange={(e) => setDocumentName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && documentName.trim() && !isCreating) handleCreateDocument();
              }}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={isCreating}>
              Cancel
            </Button>
            <Button onClick={handleCreateDocument} disabled={!documentName.trim() || isCreating}>
              {isCreating ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
