import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, ArrowUp, ArrowDown, Settings } from 'lucide-react';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { getIgtLayerInfo } from '@/domain/layerInfo';
import { findBaselineTextLayer } from '@/domain/igtConfig';
import { timeAgo, fullTimestamp } from '@/utils/formatTime';

// Sortable column header button (renders an arrow for the active column).
const SortHeader = ({ field, label, sort, onSort, className }) => {
  const active = sort.key === field;
  const Arrow = sort.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      onClick={() => onSort(field)}
      className={cn(
        'inline-flex items-center gap-1 font-medium text-muted-foreground transition-colors hover:text-foreground',
        active && 'text-foreground',
        className
      )}
    >
      {label}
      {active && <Arrow className="h-3 w-3" />}
    </button>
  );
};

export const DocumentList = ({ documents, project, projectId, client, canManage, onDocumentCreated }) => {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [documentName, setDocumentName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  // documentId -> word count. Docs with a word layer but no tokens are absent
  // (rendered 0); `hasWordLayer` false means the project has no primary token layer.
  const [wordCounts, setWordCounts] = useState({});
  const [hasWordLayer, setHasWordLayer] = useState(true);
  const [wordsLoading, setWordsLoading] = useState(true);
  const [sort, setSort] = useState({ key: 'updated', dir: 'desc' });

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
        if (!cancelled) { setHasWordLayer(false); setWordCounts({}); setWordsLoading(false); }
        return;
      }
      try {
        const res = await client.query({
          where: [['token', '?t', { layer: wordLayerId, doc: { var: '?d' } }]],
          return: { group: ['?d'], aggregates: [['count']] },
        });
        const byDoc = {};
        for (const [docId, n] of (res?.results || [])) byDoc[docId] = n;
        if (!cancelled) { setHasWordLayer(true); setWordCounts(byDoc); }
      } catch (err) {
        console.error('Word-count query failed:', err);
        if (!cancelled) { setHasWordLayer(false); setWordCounts({}); }
      } finally {
        if (!cancelled) setWordsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [project, client]);

  const handleDocumentClick = (document) => {
    window.location.href = `#/projects/${projectId}/documents/${document.id}`;
  };

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
      notifySuccess(`Document "${documentName}" created successfully`, 'Success');
      setDocumentName('');
      setOpen(false);
      if (onDocumentCreated) onDocumentCreated({ ...newDocument, name: documentName.trim() });
    } catch (error) {
      console.error('Failed to create document:', error);
      notifyError(`Failed to create document: ${error.message}`, 'Error');
    } finally {
      setIsCreating(false);
    }
  };

  const onSort = (key) =>
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  const sortedDocuments = useMemo(() => {
    const extract = {
      name: (d) => d.name?.toLowerCase() ?? '',
      words: (d) => (hasWordLayer ? (wordCounts[d.id] ?? 0) : -1),
      updated: (d) => (d.timeModified ? new Date(d.timeModified).getTime() : 0),
    }[sort.key];
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...documents].sort((a, b) => {
      const av = extract(a);
      const bv = extract(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [documents, wordCounts, hasWordLayer, sort]);

  const renderWords = (documentId) => {
    if (wordsLoading) {
      return <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-primary align-middle" />;
    }
    if (!hasWordLayer) return '—';
    return (wordCounts[documentId] ?? 0).toLocaleString();
  };

  return (
    <div className="tw mt-2">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold">Documents</h2>
        <div className="flex items-center gap-2">
          {canManage && (
            <Button variant="outline" onClick={() => navigate(`/projects/${projectId}/access`)}>
              <Settings className="h-4 w-4" /> Project Settings
            </Button>
          )}
          <Button onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" /> Create Document
          </Button>
        </div>
      </div>

      {documents.length === 0 ? (
        <div className="rounded-md border py-12 text-center text-muted-foreground">
          <p className="text-base">No documents found</p>
          <p className="mt-1 text-sm">This project doesn&apos;t have any documents yet.</p>
        </div>
      ) : (
        <TooltipProvider>
          <div className="overflow-hidden rounded-md border">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40">
                <tr>
                  <th className="px-4 py-2 text-left">
                    <SortHeader field="name" label="Document" sort={sort} onSort={onSort} />
                  </th>
                  <th className="px-4 py-2 text-right">
                    <SortHeader field="words" label="Words" sort={sort} onSort={onSort} className="justify-end" />
                  </th>
                  <th className="px-4 py-2 text-right">
                    <SortHeader field="updated" label="Updated" sort={sort} onSort={onSort} className="justify-end" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedDocuments.map((d) => (
                  <tr
                    key={d.id}
                    onClick={() => handleDocumentClick(d)}
                    className="cursor-pointer border-b last:border-0 hover:bg-accent/40"
                  >
                    <td className="px-4 py-3">
                      <div className="min-w-0">
                        <div className="truncate font-medium">{d.name}</div>
                        <div className="truncate text-xs text-muted-foreground">ID: {d.id}</div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                      {renderWords(d.id)}
                    </td>
                    <td className="px-4 py-3 text-right text-muted-foreground">
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
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TooltipProvider>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create New Document</DialogTitle>
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
              {isCreating ? 'Creating…' : 'Create Document'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
