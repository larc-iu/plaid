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
  Bot,
  Check,
  Trash2,
} from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { SearchInput, ListCount, ListPager, SortHeader } from '@ui/components/shared/list-search';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ui/components/ui/select';
import { cn } from '@ui/lib/utils';
import { humanizeFieldName } from '@/domain/vocabFields';
import { ANY_FIELD } from '@/domain/vocabItemFilter';
import { FormLabel } from './FormLabel';
import { NEW_ID } from './vocabItemsState';
import { SegmentedControl } from '@ui/components/shared/SegmentedControl.jsx';
import { t } from '@ui/lib/i18n.js';

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
  // The machine drafts (Status machine): how many, whether the list shows
  // them alone, the toggle's address, and the two actions over every one the
  // list shows (null where this person may not).
  machineCount = 0,
  machineOnly = false,
  machineTo = null,
  onMarkReviewed = null,
  onDeleteDrafts = null,
  items,
  fieldNames,
  hasGloss,
  selectedId,
  numbers,
  comments,
  usageCounts,
  canEdit,
  // Whether Replace has a field to work on (a writer cannot replace forms).
  canReplace = true,
  itemTo,
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
      className="flex max-h-[calc(100vh-14rem)] w-full shrink-0 flex-col rounded-lg border bg-card md:sticky md:top-4 md:w-96"
      style={maxHeight ? { maxHeight } : undefined}
    >
      <div className="flex flex-col gap-2 border-b p-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">{t('Entries')}</span>
          {canEdit && (
            <Button size="sm" className="h-7" asChild>
              <Link to={itemTo(NEW_ID)}>
                <Plus className="h-3.5 w-3.5" /> {t('New')}
              </Link>
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <SearchInput
            className="min-w-0 flex-1"
            inputClassName="h-8"
            placeholder={t('Search entries…')}
            value={scope.search}
            onChange={(search) => dispatch({ type: 'scope/search', search })}
          />
          <Select
            value={scope.field}
            onValueChange={(field) => dispatch({ type: 'scope/field', field })}
          >
            <SelectTrigger className="h-8 w-28 shrink-0 text-xs" aria-label={t('Search in')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY_FIELD}>{t('All fields')}</SelectItem>
              <SelectItem value="form">{t('Form')}</SelectItem>
              {fieldNames.map((name) => (
                <SelectItem key={name} value={name}>
                  {humanizeFieldName(name)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {items.length > 0 && (
            <ListCount
              shown={filteredItems.length}
              total={items.length}
              countLabel={({ n, total }) =>
                t('{total} {n, plural, one {entry} other {entries}}', { n, total })
              }
            />
          )}
        </div>
        <SegmentedControl
          label={t('View')}
          value={treeView ? 'tree' : 'flat'}
          onChange={(v) => setTreeView(v === 'tree')}
          options={[
            {
              value: 'flat',
              label: (
                <>
                  <List className="h-3.5 w-3.5" /> {t('Flat')}
                </>
              ),
            },
            {
              value: 'tree',
              label: (
                <>
                  <ListTree className="h-3.5 w-3.5" /> {t('By entry')}
                </>
              ),
            },
          ]}
        />
        {emptyField && emptyCount > 0 && (
          <button
            type="button"
            aria-pressed={emptyOnly}
            onClick={() => dispatch({ type: 'scope/toggleEmptyOnly' })}
            className={cn(
              'inline-flex w-fit items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:underline',
              emptyOnly ? 'bg-accent' : 'bg-muted',
            )}
          >
            {t('{n} without {field}', {
              n: emptyCount.toLocaleString(),
              field: humanizeFieldName(emptyField),
            })}
          </button>
        )}
        {offTagsetIds.size > 0 && (
          <button
            type="button"
            aria-pressed={scope.offTagsetOnly}
            onClick={() => dispatch({ type: 'scope/toggleOffTagsetOnly' })}
            title={
              scope.offTagsetOnly
                ? t('Show every entry')
                : t('Show only the entries with a value outside its tagset')
            }
            className={cn(
              'inline-flex w-fit items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-destructive hover:underline',
              scope.offTagsetOnly ? 'bg-destructive/20' : 'bg-destructive/10',
            )}
          >
            <AlertTriangle className="h-3 w-3" />
            {t('{n} outside tagset', { n: offTagsetIds.size.toLocaleString() })}
          </button>
        )}
        {machineCount > 0 && machineTo && (
          <Link
            to={machineTo(!machineOnly)}
            aria-current={machineOnly ? 'true' : undefined}
            title={machineOnly ? t('Show every entry') : t('Show only the machine drafts')}
            className={cn(
              'inline-flex w-fit items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground no-underline hover:underline',
              machineOnly ? 'bg-accent' : 'bg-muted',
            )}
          >
            <Bot className="h-3 w-3" />
            {t('{n, plural, one {# machine draft} other {# machine drafts}}', { n: machineCount })}
          </Link>
        )}
        {machineOnly && (onMarkReviewed || onDeleteDrafts) && (
          <div className="flex flex-wrap items-center gap-2">
            {onMarkReviewed && (
              <Button variant="outline" size="sm" className="h-7" onClick={onMarkReviewed}>
                <Check className="h-3.5 w-3.5" /> {t('Mark reviewed')}
              </Button>
            )}
            {onDeleteDrafts && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-destructive hover:text-destructive"
                onClick={onDeleteDrafts}
              >
                <Trash2 className="h-3.5 w-3.5" /> {t('Delete')}
              </Button>
            )}
          </div>
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
          <SortHeader field="form" label={t('Form')} sort={sort} onSort={onSort} />
          {hasGloss && <SortHeader field="gloss" label={t('Gloss')} sort={sort} onSort={onSort} />}
          <SortHeader
            field="uses"
            label={t('Uses')}
            sort={sort}
            onSort={onSort}
            className="justify-self-end"
          />
        </div>
      )}

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            {t('No entries yet. Click “New”.')}
          </p>
        ) : filteredItems.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            {scope.search.trim()
              ? t('No entries match “{search}”.', { search: scope.search.trim() })
              : t('No entries match.')}
          </p>
        ) : (
          <ul className="divide-y">
            {paged.pageItems.map(({ item, depth, context }) => (
              <li key={item.id}>
                <Link
                  to={itemTo(item.id)}
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
                        title={t('{n, plural, one {# comment} other {# comments}}', {
                          n: comments.countFor(item.id),
                        })}
                      >
                        <MessageSquare className="h-3 w-3" />
                        {comments.countFor(item.id)}
                      </span>
                    )}
                  </span>
                  {hasGloss && (
                    <span className="truncate font-text text-xs text-muted-foreground">
                      {item.metadata?.gloss || ''}
                    </span>
                  )}
                  <span className="text-right text-xs tabular-nums text-muted-foreground">
                    {offTagsetIds.has(item.id) && (
                      <span title={t('A value is outside its tagset')}>
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
        {canEdit && (
          <Button variant="ghost" size="sm" className="h-7 flex-1" onClick={onBulkAdd}>
            <Upload className="h-3.5 w-3.5" /> {t('Bulk Add')}
          </Button>
        )}
        {canEdit && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 flex-1"
            onClick={onReplace}
            disabled={!items.length || !canReplace}
          >
            <Replace className="h-3.5 w-3.5" /> {t('Replace')}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 flex-1"
          onClick={onExport}
          disabled={!items.length}
        >
          <Download className="h-3.5 w-3.5" /> {t('Export')}
        </Button>
      </div>
    </div>
  );
};
