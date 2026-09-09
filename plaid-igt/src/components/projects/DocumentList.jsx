import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AudioLines, ChevronRight, PenLine, Plus } from 'lucide-react';
import { DataTable } from '@/components/ui/data-table';
import { notifySuccess, notifyError, notifyWarning, humanizeError } from '@/utils/feedback';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { listPrefKey } from '@/hooks/useStickyState';
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
  // A maintainer picks how to add a document first, the way New Project does:
  // an import is a way of making one, not a separate button in the header. A
  // writer who cannot import goes straight to the name.
  const [choosing, setChoosing] = useState(false);
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

  // Each cell wraps its content in a real <a> (rather than a row onClick) so
  // the row behaves as a true link: middle-click and right-click "open in new
  // tab" work natively. Tailwind preflight (scoped to .tw) resets anchor
  // colour and underline. The cell keeps no padding of its own, so the link
  // fills it.
  const linked = (d, className, children) => (
    <a href={`#/projects/${projectId}/documents/${d.id}`} className={className}>
      {children}
    </a>
  );

  const columns = [
    {
      key: 'name',
      label: 'Document',
      sort: (d) => d.name?.toLowerCase() ?? '',
      className: 'p-0',
      render: (d) =>
        linked(
          d,
          'block px-4 py-3',
          <div className="min-w-0">
            {/* Wrap rather than truncate: a long title is the only thing
                distinguishing two recordings, so hiding its tail is worse
                than a taller row. break-words so a single very long token
                still cannot force the column wider. */}
            <div className="break-words font-medium">{d.name}</div>
            <div className="truncate text-xs text-muted-foreground">ID: {d.id}</div>
          </div>,
        ),
    },
    {
      key: 'words',
      label: 'Words',
      sort: (d) => (hasWordLayer ? (wordCounts[d.id] ?? 0) : null),
      align: 'right',
      className: 'p-0',
      headerClassName: 'w-[88px]',
      render: (d) =>
        linked(
          d,
          'block px-4 py-3 text-right tabular-nums text-muted-foreground',
          renderWords(d.id),
        ),
    },
    {
      key: 'updated',
      label: 'Updated',
      sort: (d) => (d.timeModified ? new Date(d.timeModified).getTime() : null),
      align: 'right',
      className: 'p-0',
      headerClassName: 'w-[160px]',
      render: (d) =>
        linked(
          d,
          'block whitespace-nowrap px-4 py-3 text-right text-muted-foreground',
          d.timeModified ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>{timeAgo(d.timeModified) || '—'}</span>
              </TooltipTrigger>
              <TooltipContent>{fullTimestamp(d.timeModified)}</TooltipContent>
            </Tooltip>
          ) : (
            '—'
          ),
        ),
    },
    {
      key: 'mine',
      label: 'Your last edit',
      // Never touched is null, which orders as the smallest, so descending
      // puts the documents this reader has actually worked on at the top.
      sort: (d) => (myLastEdits[d.id] ? new Date(myLastEdits[d.id]).getTime() : null),
      align: 'right',
      className: 'p-0',
      headerClassName: 'w-[150px]',
      render: (d) =>
        linked(
          d,
          'block whitespace-nowrap px-4 py-3 text-right text-muted-foreground',
          renderMine(d.id),
        ),
    },
  ];

  return (
    <div className="tw mt-2">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold">Documents</h2>
        {canWrite && (
          <Button
            onClick={() => {
              setChoosing(canManage);
              setOpen(true);
            }}
          >
            <Plus className="h-4 w-4" /> New Document
          </Button>
        )}
      </div>

      <TooltipProvider>
        <DataTable
          rows={documents}
          columns={columns}
          rowKey={(d) => d.id}
          storageKey={listPrefKey('sort', 'documents', projectId)}
          defaultSort={{ key: 'updated', dir: 'desc' }}
          search={{
            placeholder: 'Search documents…',
            match: (d, q) => (d.name || '').toLowerCase().includes(q),
          }}
          noun="document"
          empty="No documents yet."
        />
      </TooltipProvider>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New document</DialogTitle>
            <DialogDescription>
              {choosing
                ? 'How would you like to add one?'
                : 'Name the document; you can add its text on the Baseline tab afterwards.'}
            </DialogDescription>
          </DialogHeader>
          {choosing ? (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setChoosing(false)}
                className="flex items-center gap-3 rounded-lg border bg-card p-3 text-left hover:bg-muted/50"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-background">
                  <PenLine className="h-4 w-4 text-muted-foreground" />
                </span>
                <span className="flex-1">
                  <span className="block text-sm font-medium">Blank document</span>
                  <span className="block text-xs text-muted-foreground">
                    Name it now and add its text on the Baseline tab.
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
              <Link
                to={`/projects/${projectId}/import-elan`}
                className="flex items-center gap-3 rounded-lg border bg-card p-3 text-left hover:bg-muted/50"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-background">
                  <AudioLines className="h-4 w-4 text-muted-foreground" />
                </span>
                <span className="flex-1">
                  <span className="block text-sm font-medium">Import from ELAN</span>
                  <span className="block text-xs text-muted-foreground">
                    One document per .eaf file, with its tiers, speakers and time alignment.
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </Link>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="doc-name">Document Name</Label>
                <Input
                  id="doc-name"
                  placeholder="Enter document name"
                  value={documentName}
                  onChange={(e) => setDocumentName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && documentName.trim() && !isCreating)
                      handleCreateDocument();
                  }}
                  autoFocus
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)} disabled={isCreating}>
                  Cancel
                </Button>
                <Button
                  onClick={handleCreateDocument}
                  disabled={!documentName.trim() || isCreating}
                >
                  {isCreating ? 'Creating…' : 'Create'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};
