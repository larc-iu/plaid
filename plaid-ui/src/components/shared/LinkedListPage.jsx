import { Link } from 'react-router-dom';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { DataTable } from './data-table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { timeAgo, fullTimestamp } from '../../lib/formatTime.js';
import { Loading } from './Loading.jsx';
import { LoadError } from './LoadError.jsx';
import { PendingCell } from './PendingCell.jsx';

/**
 * A number that is still being counted, could not be counted, or is a number.
 *
 * A dash rather than a zero for the last case: a project with no layer to count
 * has no answer, and zero is an answer.
 */
export const CountCell = ({ value, loading }) => {
  if (loading && value === undefined) return <PendingCell />;
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
 * A column is `{key, label, align, sort, cell, nowrap, fill}`, where `cell(row)`
 * returns what goes inside the link. The `fill` column (the name) takes the
 * width the others leave and no more, so a `truncate` inside it cuts a long
 * name there, down to a floor of 10rem. Without it the column grows to the
 * whole name and pushes the rest of the row out of sight.
 *
 * `className` is added to the page's outer wrapper. The app shell already pads
 * the page and holds it to the list width, so it takes no width of its own.
 *
 * `error` says the list could not be read, and `onRetry` reads it again. A
 * list that could not be read is not an empty one, so the empty card waits
 * for a read that worked.
 */
export const LinkedListPage = ({
  title,
  action,
  className = '',
  href,
  rows,
  columns,
  loading,
  error,
  onRetry,
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
    // `min-w-40` is the floor: below it the table scrolls sideways, the way
    // it did before, rather than cutting every name to its first letters.
    className: column.fill ? 'w-full min-w-40 max-w-0 p-0' : 'p-0',
    render: (row) => linked(row, column),
  }));

  return (
    <div className={className}>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        {action}
      </div>

      {error && (
        <LoadError onRetry={onRetry} className="mb-4">
          {error}
        </LoadError>
      )}

      {loading ? (
        <Loading />
      ) : rows.length === 0 && error ? null : rows.length === 0 ? (
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
