import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { DataTable } from './data-table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { timeAgo, fullTimestamp } from '../../lib/formatTime.js';
import { notifyWarning } from '../../lib/notify.js';
import { textIncludes } from '../../domain/collation.js';

const Spinner = () => (
  <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-primary align-middle" />
);

/**
 * A project's documents, with what both apps show about one: how many words it
 * holds, when it last changed, and when this reader last wrote to it.
 *
 * `wordLayerId` is the app's, because the two count different layers: plaid-igt
 * counts its primary (word) token layer, and plaid-ud its morpheme layer, whose
 * tokens are UD's syntactic words. Undefined means the project has no such
 * layer, and the column reads as a dash rather than as zero.
 *
 * `href(documentId, {wordCount, hasWordLayer, wordsLoading})` is the app's too.
 * It takes the counts because plaid-ud sends a document with nothing in it to
 * the text editor instead of the annotation grid.
 */
export const DocumentTable = ({ documents, client, projectId, wordLayerId, href, defaultSort }) => {
  // documentId -> word count. A document with a word layer but no tokens is
  // absent (rendered 0); `hasWordLayer` false means there is no layer to count.
  const [wordCounts, setWordCounts] = useState({});
  const [hasWordLayer, setHasWordLayer] = useState(true);
  const [wordsLoading, setWordsLoading] = useState(true);
  // documentId -> when THIS reader last wrote to it. Absent means never, which
  // is a fact about them and not a gap in the data, so the cell reads as a dash
  // rather than a spinner once the read has landed.
  const [myLastEdits, setMyLastEdits] = useState({});
  const [mineLoading, setMineLoading] = useState(true);

  // Per-document word counts: one aggregate query over the layer's tokens,
  // grouped by document. Sub-word units are on another layer and would inflate
  // the count, which is why the caller names the layer rather than this
  // counting everything.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setWordsLoading(true);
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
  }, [wordLayerId, client]);

  // When this reader last touched each document, from the audit log in one
  // request. A failure here costs a column, not the list, so it warns and
  // leaves every cell empty. The response is a UUID-keyed map, which the client
  // already fetches with `skipResponseTransform` so the keys survive.
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

  const renderWords = (documentId) => {
    if (wordsLoading) return <Spinner />;
    if (!hasWordLayer) return '—';
    return (wordCounts[documentId] ?? 0).toLocaleString();
  };

  const renderMine = (documentId) => {
    if (mineLoading) return <Spinner />;
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

  // Each cell holds a real anchor rather than the row holding an onClick, so
  // middle-click and cmd-click open the document the way they do on any link.
  // The cell keeps no padding of its own, so the link fills it.
  const linked = (d, className, children) => (
    <Link
      to={href(d.id, { wordCount: wordCounts[d.id], hasWordLayer, wordsLoading })}
      className={className}
    >
      {children}
    </Link>
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
    <TooltipProvider>
      <DataTable
        rows={documents}
        columns={columns}
        rowKey={(d) => d.id}
        id="documents"
        scope={projectId}
        rememberPage
        pageParam="page"
        defaultSort={defaultSort}
        search={{
          placeholder: 'Search documents…',
          match: (d, q) => textIncludes(d.name || '', q),
        }}
        noun="document"
        empty="No documents yet."
        noMatch={(q) => `No documents match “${q}”.`}
      />
    </TooltipProvider>
  );
};
