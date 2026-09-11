import { useMemo, useState } from 'react';
import { Button } from '@ui/components/ui/button';
import { DataTable } from '@ui/components/ui/data-table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ui/components/ui/select';

// How often each value occurs among the matches, instead of the matches.
//
// Grew answers this with `cluster`, which is in the unsupported residue, so the
// same pattern is re-run as a grouped aggregate: the hits are never fetched and
// the server does the counting. The fields offered are the ones a UD pattern
// can name — a node's columns and features, and a named edge's label.
const COLUMNS = ['lemma', 'upos', 'xpos'];

export const CountBy = ({ nodes, edges, rows, total, busy, onCount, onPick }) => {
  const [choice, setChoice] = useState('');

  // Every "node.field" the pattern makes available. A FEATS key is not offered
  // by name because a pattern does not say which keys exist; FEATS as a whole
  // counts the `Key=Value` strings, which is what the picker's values look like.
  const options = useMemo(() => {
    const out = [];
    // A name is a node or an edge, never both. The compiler can report a name
    // in `nodes` that is really an edge (see `e.label` in quickSearch.js), and
    // offering `e.lemma` would be offering a search that cannot match.
    const edgeNames = new Set(edges || []);
    for (const node of (nodes || []).filter((n) => !edgeNames.has(n))) {
      for (const column of COLUMNS)
        out.push({ value: `${node}.${column}`, label: `${node}.${column}` });
      out.push({ value: `${node}.FEATS`, label: `${node}.FEATS` });
    }
    for (const edge of edges || []) out.push({ value: `${edge}.label`, label: `${edge}.label` });
    return out;
  }, [nodes, edges]);

  if (!options.length) return null;

  const run = () => {
    const [node, field] = choice.split('.');
    if (node && field) onCount({ node, field });
  };

  const columns = [
    {
      key: 'value',
      label: 'Value',
      sort: (r) => String(r.value).toLowerCase(),
      render: (r) =>
        onPick ? (
          <button
            type="button"
            className="text-left font-medium hover:underline"
            onClick={() => onPick(r.value)}
          >
            {r.value}
          </button>
        ) : (
          r.value
        ),
    },
    {
      key: 'count',
      label: 'Matches',
      align: 'right',
      className: 'tabular-nums',
      sort: (r) => r.count,
      render: (r) => r.count,
    },
    {
      key: 'share',
      label: 'Share',
      align: 'right',
      className: 'tabular-nums text-muted-foreground',
      sort: (r) => r.count,
      render: (r) => (total ? `${Math.round((r.count / total) * 100)}%` : ''),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">Count by</span>
        <Select value={choice} onValueChange={setChoice} disabled={busy}>
          <SelectTrigger className="h-8 w-48" aria-label="Count by">
            <SelectValue placeholder="Pick a field" />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" disabled={busy || !choice} onClick={run}>
          {busy ? 'Counting…' : 'Count'}
        </Button>
      </div>
      {rows && (
        <DataTable
          id="search-counts"
          rows={rows}
          columns={columns}
          rowKey={(r) => r.value}
          empty="Nothing matched."
          noun="value"
          defaultSort={{ key: 'count', dir: 'desc' }}
          search
        />
      )}
    </div>
  );
};
