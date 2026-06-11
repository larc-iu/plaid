import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search as SearchIcon, FileText } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup, SelectLabel,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { notifyError } from '@/utils/feedback';
import { getIgtLayerInfo } from '@/domain/layerInfo';
import { MATCH_TYPES, searchDomains } from './searchQueries.js';
import { runHitsSearch, runFreqSearch } from './searchRunner.js';

// Render sentence text with <mark>s over the hit ranges (code-point offsets,
// already sentence-relative and sorted).
const MarkedText = ({ text, marks }) => {
  if (!marks?.length) return <>{text}</>;
  const chars = [...text];
  const out = [];
  let pos = 0;
  marks.forEach((m, i) => {
    const b = Math.max(pos, Math.min(m.begin, chars.length));
    const e = Math.max(b, Math.min(m.end, chars.length));
    if (b > pos) out.push(chars.slice(pos, b).join(''));
    out.push(<mark key={i} className="rounded bg-yellow-200 px-0.5">{chars.slice(b, e).join('')}</mark>);
    pos = e;
  });
  if (pos < chars.length) out.push(chars.slice(pos).join(''));
  return <>{out}</>;
};

export const ProjectSearch = ({ project, projectId, client }) => {
  const navigate = useNavigate();
  const layerInfo = useMemo(() => getIgtLayerInfo(project), [project]);
  const domains = useMemo(() => searchDomains(layerInfo, project.vocabs), [layerInfo, project.vocabs]);

  const [queryText, setQueryText] = useState('');
  const [matchType, setMatchType] = useState('contains');
  const [domainId, setDomainId] = useState(domains[0]?.id ?? 'words');
  const [mode, setMode] = useState('hits'); // 'hits' | 'freq'
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const domain = domains.find((d) => d.id === domainId) ?? domains[0];

  const runSearch = async (nextMode = mode) => {
    if (!queryText.trim() || !domain || busy) return;
    setBusy(true);
    try {
      const r = nextMode === 'freq'
        ? await runFreqSearch(client, domain, queryText.trim(), matchType)
        : await runHitsSearch(client, project, layerInfo, domain, queryText.trim(), matchType);
      setResult(r);
    } catch (err) {
      console.error('Search failed:', err);
      notifyError(
        matchType === 'regex' && err?.status === 400
          ? `Search failed — check your regex: ${err.message}`
          : 'Search failed. Try again or simplify the query.',
        'Search Error'
      );
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (m) => {
    setMode(m);
    if (result && queryText.trim()) runSearch(m);
  };

  // Click-through: open the document's Analyze tab focused on the hit
  // sentence. The island consumes the sessionStorage key on first paint.
  const openHit = (docId, sentenceId) => {
    sessionStorage.setItem('igt:focus-sentence', JSON.stringify({ docId, sentenceId }));
    navigate(`/projects/${projectId}/documents/${docId}`, { state: { tab: 'analyze' } });
  };

  const grouped = useMemo(() => {
    if (!domains.length) return [];
    const word = domains.filter((d) => d.kind === 'token' || d.kind === 'morpheme');
    const fields = domains.filter((d) => d.kind === 'span');
    const lex = domains.filter((d) => d.kind === 'lexicon');
    return [
      { label: 'Forms', items: word },
      ...(fields.length ? [{ label: 'Annotations', items: fields }] : []),
      ...(lex.length ? [{ label: 'Lexicon', items: lex }] : []),
    ];
  }, [domains]);

  return (
    <div className="tw flex flex-col gap-4">
      {/* Controls */}
      <div className="rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="relative min-w-64 flex-1">
            <SearchIcon className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search this project…"
              value={queryText}
              onChange={(e) => setQueryText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
              className="pl-8"
            />
          </div>
          <Select value={matchType} onValueChange={setMatchType}>
            <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {MATCH_TYPES.map((m) => <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={domainId} onValueChange={setDomainId}>
            <SelectTrigger className="w-[210px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {grouped.map((g) => (
                <SelectGroup key={g.label}>
                  <SelectLabel>{g.label}</SelectLabel>
                  {g.items.map((d) => <SelectItem key={d.id} value={d.id}>{d.label}</SelectItem>)}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={() => runSearch()} disabled={busy || !queryText.trim()}>
            {busy ? 'Searching…' : 'Search'}
          </Button>
        </div>
        <div className="mt-3 flex items-center gap-1 text-sm">
          {[['hits', 'Hits'], ['freq', 'Frequencies']].map(([m, label]) => (
            <button
              key={m}
              type="button"
              onClick={() => switchMode(m)}
              className={cn(
                'rounded px-3 py-1 transition-colors',
                mode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Results */}
      {result?.mode === 'hits' && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            {result.totalHits.toLocaleString()} hit{result.totalHits === 1 ? '' : 's'} in{' '}
            {result.totalDocs} document{result.totalDocs === 1 ? '' : 's'}
            {result.truncated ? ' (capped — refine your search for exact totals)' : ''}
          </p>
          {result.groups.map((g) => (
            <div key={g.docId} className="rounded-lg border bg-card">
              <div className="flex items-center gap-2 border-b bg-muted/50 px-4 py-2">
                <FileText className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">{g.docName}</span>
                <span className="text-xs text-muted-foreground">{g.docHits} hit{g.docHits === 1 ? '' : 's'}</span>
              </div>
              <div className="divide-y">
                {g.rows.map((row) => (
                  <button
                    key={row.sentenceId}
                    type="button"
                    onClick={() => openHit(g.docId, row.sentenceId)}
                    className="block w-full px-4 py-2 text-left hover:bg-muted/50"
                    title="Open in Analyze"
                  >
                    <p className="text-sm">
                      <span className="mr-2 text-xs text-muted-foreground">#{row.sentenceIndex + 1}</span>
                      <MarkedText text={row.text} marks={row.marks} />
                    </p>
                    {row.notes.length > 0 && (
                      <p className="mt-0.5 text-xs text-violet-700">{[...new Set(row.notes)].join(' · ')}</p>
                    )}
                    {row.translation && (
                      <p className="mt-0.5 text-xs italic text-muted-foreground">‘{row.translation}’</p>
                    )}
                  </button>
                ))}
                {g.rows.length === 0 && (
                  <p className="px-4 py-2 text-xs text-muted-foreground">
                    Hits in this document could not be located (it may have changed since the search) — open it to look.
                  </p>
                )}
              </div>
            </div>
          ))}
          {result.remainingDocs > 0 && (
            <p className="text-sm text-muted-foreground">
              … plus {result.remainingHits.toLocaleString()} more hit{result.remainingHits === 1 ? '' : 's'} in{' '}
              {result.remainingDocs} more document{result.remainingDocs === 1 ? '' : 's'} — refine your search to see them.
            </p>
          )}
          {result.totalHits === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">No hits.</p>
          )}
        </div>
      )}

      {result?.mode === 'freq' && (
        <div className="rounded-lg border bg-card p-4">
          <p className="mb-3 text-sm text-muted-foreground">
            {result.totalValues.toLocaleString()} distinct value{result.totalValues === 1 ? '' : 's'} ·{' '}
            {result.totalHits.toLocaleString()} total occurrence{result.totalHits === 1 ? '' : 's'}
            {result.totalValues > result.rows.length ? ` (showing top ${result.rows.length})` : ''}
          </p>
          {result.rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No matches.</p>
          ) : (
            <div className="overflow-hidden rounded-md border">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Value</th>
                    <th className="w-28 px-3 py-2 text-right font-medium">Count</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map(([value, n]) => (
                    <tr key={value} className="border-t hover:bg-muted/50">
                      <td className="px-3 py-1.5">{value}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{n.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {!result && (
        <p className="py-10 text-center text-sm text-muted-foreground">
          Search word forms, morphemes, annotations, or lexicon links across every document in this project.
        </p>
      )}
    </div>
  );
};
