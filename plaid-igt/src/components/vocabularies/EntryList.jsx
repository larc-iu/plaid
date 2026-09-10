import { Link } from 'react-router-dom';
import {
  Plus,
  AlertTriangle,
  Upload,
  Download,
  MessageSquare,
  Replace,
  List,
  ListTree,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SearchInput, ListCount, ListPager, SortHeader } from '@/components/ui/list-search';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { humanizeFieldName } from '@/domain/vocabFields';
import { ANY_FIELD } from '@/domain/vocabItemFilter';
import { FormLabel } from './FormLabel';
import { NEW_ID } from './vocabItemsState';

// The left pane: the search box and its scope, the view toggle, the paged
// rows, and the footer's bulk actions. `list` is a useEntryList; `scope` and
// `dispatch` are the screen's reducer.
export const EntryList = ({
  list,
  scope,
  dispatch,
  emptyOnly,
  emptyField,
  emptyCount,
  offTagsetIds,
  items,
  fieldNames,
  hasGloss,
  selectedId,
  numbers,
  comments,
  usageCounts,
  canManage,
  itemTo,
  guardSelect,
  maxHeight,
  onBulkAdd,
  onReplace,
  onExport,
}) => {
  const { filteredItems, paged, setPage, sort, onSort, treeView, setTreeView, listRef } = list;
  const listCols = hasGloss
    ? 'grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_auto]'
    : 'grid-cols-[minmax(0,1fr)_auto]';

  return (
    <div
      className="sticky top-4 flex max-h-[calc(100vh-14rem)] w-96 shrink-0 flex-col rounded-lg border bg-card"
      style={maxHeight ? { maxHeight } : undefined}
    >
      <div className="flex flex-col gap-2 border-b p-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Entries</span>
          {canManage && (
            <Button size="sm" className="h-7" asChild>
              <Link to={itemTo(NEW_ID)} onClick={(e) => guardSelect(e, NEW_ID)}>
                <Plus className="h-3.5 w-3.5" /> New
              </Link>
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <SearchInput
            className="min-w-0 flex-1"
            inputClassName="h-8"
            placeholder="Search entries…"
            value={scope.search}
            onChange={(search) => dispatch({ type: 'scope/search', search })}
          />
          <Select
            value={scope.field}
            onValueChange={(field) => dispatch({ type: 'scope/field', field })}
          >
            <SelectTrigger className="h-8 w-28 shrink-0 text-xs" aria-label="Search in">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY_FIELD}>All fields</SelectItem>
              <SelectItem value="form">Form</SelectItem>
              {fieldNames.map((name) => (
                <SelectItem key={name} value={name}>
                  {humanizeFieldName(name)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {items.length > 0 && (
            <ListCount shown={filteredItems.length} total={items.length} noun="entry" />
          )}
        </div>
        <div className="flex items-center gap-1" role="group" aria-label="View">
          <button
            type="button"
            aria-pressed={!treeView}
            title="Every entry in one list"
            onClick={() => setTreeView(false)}
            className={cn(
              'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground',
              !treeView && 'bg-accent text-foreground',
            )}
          >
            <List className="h-3.5 w-3.5" /> Flat
          </button>
          <button
            type="button"
            aria-pressed={treeView}
            title="Senses under their entry"
            onClick={() => setTreeView(true)}
            className={cn(
              'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground',
              treeView && 'bg-accent text-foreground',
            )}
          >
            <ListTree className="h-3.5 w-3.5" /> By entry
          </button>
        </div>
        {emptyField && emptyCount > 0 && (
          <button
            type="button"
            aria-pressed={emptyOnly}
            onClick={() => dispatch({ type: 'scope/toggleEmptyOnly' })}
            className={cn(
              'inline-flex w-fit items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:underline',
              emptyOnly ? 'bg-accent' : 'bg-muted',
            )}
          >
            {emptyCount.toLocaleString()} without {humanizeFieldName(emptyField)}
          </button>
        )}
        {offTagsetIds.size > 0 && (
          <button
            type="button"
            aria-pressed={scope.offTagsetOnly}
            onClick={() => dispatch({ type: 'scope/toggleOffTagsetOnly' })}
            title={
              scope.offTagsetOnly
                ? 'Show every entry'
                : 'Show only the entries with a value outside its tagset'
            }
            className={cn(
              'inline-flex w-fit items-center gap-1 rounded px-1.5 py-0.5 text-xs text-destructive hover:underline',
              scope.offTagsetOnly ? 'bg-destructive/20' : 'bg-destructive/10',
            )}
          >
            <AlertTriangle className="h-3 w-3" />
            {offTagsetIds.size.toLocaleString()} outside tagset
          </button>
        )}
      </div>

      <ListPager {...paged} onPage={setPage} position="top" />

      {items.length > 0 && filteredItems.length > 0 && (
        <div
          className={cn(
            'grid items-center gap-2 border-b px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground',
            listCols,
          )}
        >
          <SortHeader field="form" label="Form" sort={sort} onSort={onSort} />
          {hasGloss && <SortHeader field="gloss" label="Gloss" sort={sort} onSort={onSort} />}
          <SortHeader
            field="uses"
            label="Uses"
            sort={sort}
            onSort={onSort}
            className="justify-self-end"
          />
        </div>
      )}

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            No entries yet. Click “New”.
          </p>
        ) : filteredItems.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            {scope.search.trim()
              ? `No entries match “${scope.search.trim()}”.`
              : 'No entries match.'}
          </p>
        ) : (
          <ul className="divide-y">
            {paged.pageItems.map(({ item, depth, context }) => (
              <li key={item.id}>
                <Link
                  to={itemTo(item.id)}
                  onClick={(e) => guardSelect(e, item.id)}
                  data-selected={selectedId === item.id || undefined}
                  data-depth={depth || undefined}
                  data-context={context || undefined}
                  className={cn(
                    'grid w-full items-center gap-2 px-3 py-2 text-left text-sm no-underline hover:bg-accent/40',
                    listCols,
                    selectedId === item.id && 'bg-accent/60',
                    // Not a hit, only the entry a hit sits under.
                    context && 'opacity-50',
                  )}
                  style={depth ? { paddingLeft: `${0.75 + depth * 1.25}rem` } : undefined}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <FormLabel
                      form={item.form}
                      index={numbers.get(item.id)}
                      className="truncate font-medium"
                    />
                    {(comments?.countFor(item.id) ?? 0) > 0 && (
                      <span
                        className="inline-flex shrink-0 items-center gap-0.5 text-[10px] tabular-nums text-muted-foreground"
                        title={`${comments.countFor(item.id)} comment${comments.countFor(item.id) === 1 ? '' : 's'}`}
                      >
                        <MessageSquare className="h-3 w-3" />
                        {comments.countFor(item.id)}
                      </span>
                    )}
                  </span>
                  {hasGloss && (
                    <span className="truncate text-xs text-muted-foreground">
                      {item.metadata?.gloss || ''}
                    </span>
                  )}
                  <span className="text-right text-xs tabular-nums text-muted-foreground">
                    {offTagsetIds.has(item.id) && (
                      <span title="A value is outside its tagset">
                        <AlertTriangle className="mr-1 inline h-3 w-3 text-destructive" />
                      </span>
                    )}
                    {usageCounts ? (usageCounts[item.id] ?? 0) : ''}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ListPager {...paged} onPage={setPage} />

      <div className="flex items-center gap-2 border-t p-2">
        {canManage && (
          <Button variant="ghost" size="sm" className="h-7 flex-1" onClick={onBulkAdd}>
            <Upload className="h-3.5 w-3.5" /> Bulk Add
          </Button>
        )}
        {canManage && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 flex-1"
            onClick={onReplace}
            disabled={!items.length}
          >
            <Replace className="h-3.5 w-3.5" /> Replace
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 flex-1"
          onClick={onExport}
          disabled={!items.length}
        >
          <Download className="h-3.5 w-3.5" /> Export
        </Button>
      </div>
    </div>
  );
};
