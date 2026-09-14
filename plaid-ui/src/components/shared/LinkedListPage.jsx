import { Link } from 'react-router-dom';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { DataTable } from './data-table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { timeAgo, fullTimestamp } from '../../lib/formatTime.js';

/**
 * A number that is still being counted, could not be counted, or is a number.
 *
 * A dash rather than a zero for the last case: a project with no layer to count
 * has no answer, and zero is an answer.
 */
export const CountCell = ({ value, loading }) => {
  if (loading && value === undefined)
    return (
      <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-primary align-middle" />
    );
  return value == null ? '—' : value.toLocaleString();
};

/** When something last changed, with the exact moment on hover. */
export const TimeCell = ({ at }) =>
  at ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>{timeAgo(at) || '—'}</span>
      </TooltipTrigger>
      <TooltipContent>{fullTimestamp(at)}</TooltipContent>
    </Tooltip>
  ) : (
    '—'
  );

/**
 * A top-level list of things you open: projects, vocabularies.
 *
 * Every cell holds a real anchor rather than the row holding an onClick, so
 * middle-click and cmd-click open the row the way they do on any link, and the
 * whole row is still a target. The cell keeps no padding of its own, so the
 * link fills it: that is what `columns` gives up in exchange for naming only
 * its content.
 *
 * A column is `{key, label, align, sort, cell, nowrap}`, where `cell(row)`
 * returns what goes inside the link.
 *
 * `className` is the page's outer wrapper, because the two shells differ:
 * plaid-ud's Outlet is already padded and plaid-igt's is not.
 */
export const LinkedListPage = ({
  title,
  action,
  className = 'mx-auto max-w-5xl px-4 py-8',
  href,
  rows,
  columns,
  loading,
  error,
  empty,
  tableId,
  noun,
  defaultSort,
  search,
}) => {
  const linked = (row, column) => (
    <Link
      to={href(row)}
      className={[
        'block px-4 py-3',
        column.align === 'right' ? 'text-right tabular-nums text-muted-foreground' : '',
        column.nowrap ? 'whitespace-nowrap' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {column.cell(row)}
    </Link>
  );

  const tableColumns = columns.map((column) => ({
    key: column.key,
    label: column.label,
    sort: column.sort,
    align: column.align,
    headerClassName: column.headerClassName,
    className: 'p-0',
    render: (row) => linked(row, column),
  }));

  return (
    <div className={className}>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        {action}
      </div>

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-24 text-muted-foreground">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
        </div>
      ) : rows.length === 0 ? (
        <Card className="p-10 text-center text-muted-foreground">
          <p className="text-lg">{empty.title}</p>
          <p className="mt-1 text-sm">{empty.hint}</p>
        </Card>
      ) : (
        <TooltipProvider>
          <DataTable
            rows={rows}
            columns={tableColumns}
            rowKey={(row) => row.id}
            id={tableId}
            defaultSort={defaultSort}
            search={search}
            noun={noun}
          />
        </TooltipProvider>
      )}
    </div>
  );
};

/** A header action that is a link, which is what "New X" always is. */
export const NewLinkButton = ({ to, children }) => (
  <Button asChild>
    <Link to={to}>{children}</Link>
  </Button>
);
