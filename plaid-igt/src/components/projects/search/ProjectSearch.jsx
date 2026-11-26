import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { FileText } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { SearchInput, ListHint } from '@ui/components/shared/list-search';
import { DataTable } from '@ui/components/shared/data-table';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectLabel,
} from '@ui/components/ui/select';
import { notifyError, humanizeError } from '@/utils/feedback';
import { isQueryTimeout } from '@ui/lib/errors.js';
import { getIgtLayerInfo } from '@/domain/layerInfo';
import { MATCH_TYPES, searchDomains } from './searchQueries.js';
import { PatternError } from '@ui/domain/javaRegex.js';
import { runHitsSearch, runFreqSearch } from './searchRunner.js';
import { SegmentedControl } from '@ui/components/shared/SegmentedControl.jsx';
import { MarkedText } from '@ui/components/shared/MarkedText.jsx';
import { hitTo, rememberCaret } from './hitLinks.js';
import { t, tx, tc } from '@ui/lib/i18n.js';
import { isEnter } from '@ui/lib/chords.js';
import { NoteLine } from './NoteLine.jsx';

// A query as it was searched, in quotes: its spaces kept and shown, and its
// own direction kept inside a line in the page's.
const searched = (query) => <bdi className="whitespace-pre-wrap">{query}</bdi>;

export const ProjectSearch = ({ project, projectId, client }) => {
  const layerInfo = useMemo(() => getIgtLayerInfo(project), [project]);
  const domains = useMemo(
    () => searchDomains(layerInfo, project.vocabs),
    [layerInfo, project.vocabs],
  );

  // The search that RAN lives in the URL; the boxes hold what is being typed.
  // Leaving for the Documents tab and coming back used to give an empty box,
  // `contains`, `Words`, `Hits` and no results, so checking one hit in the
  // editor meant retyping the query, while the document list's sort and page
  // beside it came back every time. It also makes a search shareable.
  const [params, setParams] = useSearchParams();
  const ran = {
    q: params.get('q') || '',
    match: params.get('match') || 'contains',
    in: params.get('in') || domains[0]?.id || 'words',
    mode: params.get('mode') === 'freq' ? 'freq' : 'hits',
  };

  const [queryText, setQueryText] = useState(ran.q);
  const [matchType, setMatchType] = useState(ran.match);
  const [domainId, setDomainId] = useState(ran.in);
  const [mode, setMode] = useState(ran.mode);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  // Write what a run used, replacing rather than pushing: a search is where
  // you already are, not somewhere you went, so Back leaves the tab.
  const remember = (q, match, inDomain, m) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of [
          ['q', q],
          ['match', match],
          ['in', inDomain],
          ['mode', m === 'freq' ? 'freq' : ''],
        ]) {
          if (v) next.set(k, v);
          else next.delete(k);
        }
        return next;
      },
      { replace: true },
    );

  // A frequency row is [value, count]. Value orders by the locale rather than
  // case-folded, since these are forms in the language being documented.
  const freqColumns = [
    { key: 'value', label: t('Value'), sort: (r) => r[0], render: (r) => r[0] },
    {
      key: 'count',
      label: t('Count'),
      sort: (r) => r[1],
      align: 'right',
      className: 'tabular-nums text-muted-foreground',
      headerClassName: 'w-28',
      render: (r) => r[1].toLocaleString(),
    },
  ];

  const domain = domains.find((d) => d.id === domainId) ?? domains[0];

  const runSearch = async (nextMode = mode) => {
    if (!queryText.trim() || !domain || busy) return;
    setBusy(true);
    remember(queryText, matchType, domainId, nextMode);
    try {
      const r =
        nextMode === 'freq'
          ? await runFreqSearch(client, domain, queryText, matchType)
          : await runHitsSearch(client, project, layerInfo, domain, queryText, matchType);
      // The query it was for, as searched, for the line that says it found
      // nothing (a stray space then shows).
      setResult({ ...r, query: queryText });
    } catch (err) {
      // The box and the URL now say this query, so the last one's hits go.
      setResult(null);
      if (!(err instanceof PatternError)) console.error('Search failed:', err);
      // The server's 400 reads ":value has an invalid regex: Unclosed group
      // near index 1 (" — keep only the engine's own explanation.
      const detail = humanizeError(err, '').replace(/^.*?invalid regex:\s*/i, '');
      notifyError(
        err instanceof PatternError
          ? t('Check your regex: {error}', { error: err.message })
          : matchType === 'regex' && err?.status === 400
            ? detail
              ? t('Check your regex: {error}', { error: detail })
              : t('Check your regex: the pattern is invalid.')
            : isQueryTimeout(err)
              ? detail
              : t('Try again or simplify the query.'),
        t('Failed to search'),
      );
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (m) => {
    setMode(m);
    if (result && queryText.trim()) runSearch(m);
  };

  // Arriving with a search in the URL runs it: a filled box over no results is
  // half of coming back. Once, guarded by a ref rather than by `result`, so a
  // search that legitimately found nothing is not run again on every render.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !ran.q || !domains.length) return;
    restored.current = true;
    runSearch(ran.mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ran.q, domains.length]);

  const grouped = useMemo(() => {
    if (!domains.length) return [];
    const word = domains.filter((d) => d.kind === 'token' || d.kind === 'morpheme');
    const fields = domains.filter((d) => d.kind === 'span');
    const lex = domains.filter((d) => d.kind === 'lexicon');
    return [
      { label: t('Forms'), items: word },
      ...(fields.length ? [{ label: t('Annotations'), items: fields }] : []),
      ...(lex.length ? [{ label: t('Lexicon'), items: lex }] : []),
    ];
  }, [domains]);

  return (
    <div className="flex flex-col gap-4">
      {/* Controls */}
      <div className="rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-end gap-2">
          <SearchInput
            className="min-w-64 flex-1"
            placeholder={t('Search this project…')}
            // A pattern is a format and reads one way. A plain search is
            // whatever was typed into it.
            dir={matchType === 'regex' ? 'ltr' : 'auto'}
            value={queryText}
            onChange={setQueryText}
            onKeyDown={(e) => {
              if (isEnter(e)) runSearch();
            }}
          />
          <Select value={matchType} onValueChange={setMatchType}>
            <SelectTrigger className="w-[240px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MATCH_TYPES.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {t(m.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={domainId} onValueChange={setDomainId}>
            <SelectTrigger className="w-[210px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {grouped.map((g) => (
                <SelectGroup key={g.label}>
                  <SelectLabel>{g.label}</SelectLabel>
                  {g.items.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={() => runSearch()} disabled={busy || !queryText.trim()}>
            {busy ? t('Searching…') : t('Search')}
          </Button>
        </div>
        <SegmentedControl
          label={tc('noun', 'View')}
          className="mt-3"
          value={mode}
          onChange={switchMode}
          options={[
            { value: 'hits', label: t('Hits') },
            { value: 'freq', label: t('Frequencies') },
          ]}
        />
      </div>

      {/* Results */}
      {result?.mode === 'hits' && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            {result.truncated
              ? t(
                  '{n, plural, one {# hit} other {# hits}} in {docs, plural, one {# document} other {# documents}} (capped, so refine your search for exact totals)',
                  { n: result.totalHits, docs: result.totalDocs },
                )
              : t(
                  '{n, plural, one {# hit} other {# hits}} in {docs, plural, one {# document} other {# documents}}',
                  { n: result.totalHits, docs: result.totalDocs },
                )}
          </p>
          {result.groups.map((g) => (
            <div key={g.docId} className="rounded-lg border bg-card">
              <div className="flex items-center gap-2 border-b bg-muted/50 px-4 py-2">
                <FileText className="h-4 w-4 text-muted-foreground" />
                <span dir="auto" className="font-text text-sm font-medium">
                  {g.docName}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t('{n, plural, one {# hit} other {# hits}}', { n: g.docHits })}
                </span>
              </div>
              <div className="divide-y">
                {g.rows.map((row) => (
                  <Link
                    key={row.sentenceId}
                    to={hitTo(projectId, g.docId, row.sentenceId)}
                    onClick={(e) => rememberCaret(e, g.docId, row.sentenceId, row.hitBegin ?? null)}
                    className="block w-full px-4 py-2 text-left hover:bg-muted/50"
                    title={t('Open in Analyze')}
                  >
                    <p className="text-sm">
                      <span className="mr-2 text-xs text-muted-foreground">
                        #{row.sentenceIndex + 1}
                      </span>
                      <MarkedText text={row.text} marks={row.marks} />
                    </p>
                    {row.notes.length > 0 && (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        <NoteLine notes={row.notes} />
                      </p>
                    )}
                    {row.translation && (
                      <p
                        dir="auto"
                        className="mt-0.5 font-text text-xs italic text-muted-foreground"
                      >
                        ‘{row.translation}’
                      </p>
                    )}
                  </Link>
                ))}
                {g.capped ? (
                  <p className="px-4 py-2 text-xs text-muted-foreground">
                    {t(
                      'Too many hits in this document to show them all. Narrow the search to see the rest.',
                    )}
                  </p>
                ) : (
                  g.rows.length === 0 && (
                    <p className="px-4 py-2 text-xs text-muted-foreground">
                      {t('Hits in this document could not be located. Open it to look.')}
                    </p>
                  )
                )}
              </div>
            </div>
          ))}
          {result.remainingDocs > 0 && (
            <ListHint>
              {t(
                'Another {n, plural, one {# hit} other {# hits}} in {docs, plural, one {# more document} other {# more documents}} are not shown. Refine your search to see them.',
                { n: result.remainingHits, docs: result.remainingDocs },
              )}
            </ListHint>
          )}
          {result.totalHits === 0 && (
            <p className="break-words py-6 text-center text-sm text-muted-foreground">
              {tx('No hits for “{query}”.', { query: searched(result.query) })}
            </p>
          )}
        </div>
      )}

      {result?.mode === 'freq' && (
        <div className="rounded-lg border bg-card p-4">
          <p className="mb-3 text-sm text-muted-foreground">
            {t(
              '{n, plural, one {# distinct value} other {# distinct values}} · {total, plural, one {# total occurrence} other {# total occurrences}}',
              { n: result.totalValues, total: result.totalHits },
            )}
          </p>
          {result.rows.length === 0 ? (
            <p className="break-words py-6 text-center text-sm text-muted-foreground">
              {tx('No matches for “{query}”.', { query: searched(result.query) })}
            </p>
          ) : (
            <DataTable
              rows={result.rows}
              columns={freqColumns}
              rowKey={(r) => r[0]}
              id="search-freq"
              defaultSort={{ key: 'count', dir: 'desc' }}
              countLabel={(v) => t('{total} {n, plural, one {value} other {values}}', v)}
              noMatch={t('No values match.')}
              // The line above already says how many distinct values there
              // are, how many occurrences, and that the list is capped.
              showCount={false}
            />
          )}
          {/* Under the table, where the pager is. The pager counts the rows it
              was handed ("1-100 of 200"), which read as the corpus having 200
              distinct forms when the line above said 11,130. */}
          {result.totalValues > result.rows.length && (
            <ListHint>
              {t(
                'Another {n, plural, one {# value} other {# values}} are not shown. Refine your search to see them.',
                { n: result.totalValues - result.rows.length },
              )}
            </ListHint>
          )}
        </div>
      )}

      {!result && (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {t(
            'Search word forms, morphemes, annotations, or lexicon links across every document in this project.',
          )}
        </p>
      )}
    </div>
  );
};
