import { useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Plus,
  Trash2,
  AlertTriangle,
  Upload,
  Download,
  Search,
  FileText,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { notifySuccess, notifyError, notifyWarning, isPermissionError } from '@/utils/feedback';
import { FLEX_MORPH_TYPES } from '@/domain/affixMarkers';
import { humanizeFieldName } from '@/domain/vocabFields';
import { buildHomonymIndex } from '@/domain/vocabHomonyms';
import { planItemConcordance, loadConcordanceGroups } from './vocabConcordance';
import { serializeVocabTsv } from '@/export/vocabTsv';
import { BulkAddDialog } from './BulkAddDialog';
import { downloadBlob, sanitizeFilename } from '@/export/files';

const NEW_ID = '__new__';
const PAGE_SIZE = 100;

// Drop blank/nullish values so we never persist empty-string metadata keys.
const cleanMeta = (obj) => {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v != null && String(v).trim() !== '') out[k] = v;
  }
  return out;
};

const metaEqual = (a, b) => {
  const ca = cleanMeta(a);
  const cb = cleanMeta(b);
  const ka = Object.keys(ca);
  if (ka.length !== Object.keys(cb).length) return false;
  return ka.every((k) => String(ca[k]) === String(cb[k]));
};

// A form with its homonym subscript (form₂) when the form is shared by 2+ items.
const FormLabel = ({ form, index, className = '' }) => (
  <span className={className}>
    {form}
    {index != null && <sub className="ml-0.5 text-[0.7em] text-muted-foreground">{index}</sub>}
  </span>
);

// Render sentence text with <mark>s over hit ranges (sentence-relative, sorted).
const MarkedText = ({ text, marks }) => {
  if (!marks?.length) return <>{text}</>;
  const chars = [...text];
  const out = [];
  let pos = 0;
  marks.forEach((m, i) => {
    const b = Math.max(pos, Math.min(m.begin, chars.length));
    const e = Math.max(b, Math.min(m.end, chars.length));
    if (b > pos) out.push(chars.slice(pos, b).join(''));
    out.push(
      <mark key={i} className="rounded bg-yellow-200 px-0.5">
        {chars.slice(b, e).join('')}
      </mark>,
    );
    pos = e;
  });
  if (pos < chars.length) out.push(chars.slice(pos).join(''));
  return <>{out}</>;
};

// Read-only facts a FLEx import stores outside the field schema: the FLEx
// homograph number and the sense's example sentences (metadata.examples is
// structured, so it is never a field column).
const ImportedExtras = ({ metadata }) => {
  const examples = Array.isArray(metadata?.examples)
    ? metadata.examples.filter((ex) => ex && ex.text)
    : [];
  const homograph = Number(metadata?.homograph) || 0;
  if (!examples.length && !homograph) return null;
  return (
    <div className="mt-4 flex flex-col gap-2 border-t pt-3 text-sm">
      {homograph > 0 && (
        <p className="text-xs text-muted-foreground">FLEx homograph number {homograph}</p>
      )}
      {examples.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Examples
          </p>
          <ul className="flex flex-col gap-1.5">
            {examples.map((ex, i) => (
              <li key={i}>
                <span>{ex.text}</span>
                {ex.translation && (
                  <span className="block text-muted-foreground">{ex.translation}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export const VocabularyItems = ({ vocabularyId, vocabulary, client, fields, canManage = true }) => {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Selection + inline edit draft (NEW_ID = unsaved new item).
  const [selectedId, setSelectedId] = useState(null);
  const [editForm, setEditForm] = useState('');
  const [editFields, setEditFields] = useState({});
  // Confirm before discarding unsaved edits on a selection switch.
  const [discardOpen, setDiscardOpen] = useState(false);
  const [pendingTarget, setPendingTarget] = useState(null); // {type:'item', item} | {type:'new'}

  // Left-list search, pagination, usage counts, bulk add, delete confirm.
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const listRef = useRef(null);
  // Size the sticky left pane to fit from its own top to the viewport bottom, so
  // its footer is always visible without scrolling — measured (not a guessed
  // chrome constant) so it's immune to breadcrumb wrapping / zoom / etc.
  const paneWrapRef = useRef(null);
  const [paneMaxH, setPaneMaxH] = useState(null);
  const [usageCounts, setUsageCounts] = useState(null); // {itemId: n} | null
  const [usageKinds, setUsageKinds] = useState(null); // {itemId: {word: n, morpheme: n}} | null
  const [bulkOpen, setBulkOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Concordance for the selected item: a cheap plan (queries) + lazily-loaded,
  // batched document groups that infinite-scroll.
  const CONC_BATCH = 8;
  const [concPlan, setConcPlan] = useState(null);
  const [concGroups, setConcGroups] = useState([]);
  const [concLoaded, setConcLoaded] = useState(0); // # of docs loaded so far
  const [concLoading, setConcLoading] = useState(false); // plan + first batch
  const [concLoadingMore, setConcLoadingMore] = useState(false);
  const [concError, setConcError] = useState('');
  const concReq = useRef(0);
  const loadingMoreRef = useRef(false);
  const sentinelRef = useRef(null);
  const loadMoreRef = useRef(() => {});

  const fieldNames = useMemo(() => fields.map((f) => f.name), [fields]);
  const hasGloss = useMemo(() => fields.some((f) => f.name === 'gloss'), [fields]);
  const homonyms = useMemo(() => buildHomonymIndex(items), [items]);

  const selectedItem = useMemo(
    () =>
      selectedId && selectedId !== NEW_ID ? items.find((i) => i.id === selectedId) || null : null,
    [items, selectedId],
  );
  const isNew = selectedId === NEW_ID;

  const fetchItems = async () => {
    try {
      setLoading(true);
      if (!client) throw new Error('Not authenticated');
      if (!vocabularyId || vocabularyId === 'undefined' || vocabularyId === 'new') {
        throw new Error('Invalid vocabulary ID');
      }
      const vocabularyData = await client.vocabLayers.get(vocabularyId, true);
      const fetched = vocabularyData.items || [];
      setItems(fetched);
      setError('');
      fetchUsageCounts(); // not awaited
      return fetched;
    } catch (err) {
      setError('Failed to load vocabulary items');
      console.error('Error fetching vocabulary items:', err);
      return null;
    } finally {
      setLoading(false);
    }
  };

  // A bulk import can fill in the very item the detail editor has open, which
  // would leave its draft showing pre-import values (and looking dirty against
  // the refreshed item). Re-seed the draft from what came back, unless the
  // user really does have unsaved edits, which stay theirs.
  const handleImported = async () => {
    const wasDirty = dirty;
    const openId = selectedId;
    const refreshed = await fetchItems();
    if (wasDirty || !openId || openId === NEW_ID || !refreshed) return;
    const item = refreshed.find((i) => i.id === openId);
    if (item) selectItem(item);
    else setSelectedId(null);
  };

  // One grouped aggregate query: links per item AND per token-layer role
  // across every readable project. The role splits each entry's uses into
  // words and morphemes (an entry may be linked from both).
  const fetchUsageCounts = async () => {
    try {
      const res = await client.query({
        where: [
          ['vocab', '?v', { layer: vocabularyId }],
          ['vocab-link', '?t', '?v'],
          ['token', '?t', { layer: '?tl' }],
          ['token-layer', '?tl', {}],
        ],
        return: { group: ['?v', '?tl.config.plaid.role'], aggregates: [['count']] },
      });
      const counts = {};
      const kinds = {};
      for (const [itemId, role, n] of res?.results || []) {
        counts[itemId] = (counts[itemId] || 0) + n;
        if (role === 'word' || role === 'morpheme') {
          (kinds[itemId] ||= {})[role] = ((kinds[itemId] || {})[role] || 0) + n;
        }
      }
      setUsageCounts(counts);
      setUsageKinds(kinds);
    } catch (err) {
      console.error('Usage-count query failed:', err);
      setUsageCounts(null);
      setUsageKinds(null);
      if (!isPermissionError(err)) {
        notifyWarning('Usage counts could not be loaded.', 'Usage counts unavailable');
      }
    }
  };

  useEffect(() => {
    if (vocabularyId && vocabularyId !== 'new') {
      fetchItems();
    } else {
      setLoading(false);
      setItems([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vocabularyId]);

  // Deep link to one entry: `?item=<id>` (the Analyze popover links here).
  // Once the items are in, select it and narrow the list to its form so it is
  // on screen; the param is consumed (dropped from the URL) so a later manual
  // selection isn't fought by a re-render.
  const [searchParams, setSearchParams] = useSearchParams();
  const linkedItemId = searchParams.get('item');
  useEffect(() => {
    if (!linkedItemId || loading) return;
    const item = items.find((i) => i.id === linkedItemId);
    if (item) {
      selectItem(item);
      setSearch(item.form);
      setPage(0);
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('item');
        return next;
      },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedItemId, loading, items]);

  // Plan the concordance + load the first batch whenever a real item is selected.
  useEffect(() => {
    if (!selectedId || selectedId === NEW_ID) {
      setConcPlan(null);
      setConcGroups([]);
      setConcLoaded(0);
      setConcError('');
      return;
    }
    const my = ++concReq.current;
    loadingMoreRef.current = false;
    setConcPlan(null);
    setConcGroups([]);
    setConcLoaded(0);
    setConcError('');
    setConcLoading(true);
    planItemConcordance(client, vocabularyId, selectedId)
      .then(async (plan) => {
        if (concReq.current !== my) return;
        setConcPlan(plan);
        const first = plan.docs.slice(0, CONC_BATCH);
        const groups = await loadConcordanceGroups(client, plan.hitIds, first);
        if (concReq.current !== my) return;
        setConcGroups(groups);
        setConcLoaded(first.length);
        setConcLoading(false);
      })
      .catch((err) => {
        if (concReq.current !== my) return;
        console.error('Concordance failed:', err);
        setConcError('Could not load usage examples.');
        setConcLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, vocabularyId]);

  // Load the next batch of documents (called by the infinite-scroll sentinel or
  // its Load-more button). A synchronous ref guards against double-firing.
  const concHasMore = !!concPlan && concLoaded < concPlan.docs.length;
  const loadMore = async () => {
    if (!concPlan || loadingMoreRef.current || concLoaded >= concPlan.docs.length) return;
    const my = concReq.current;
    loadingMoreRef.current = true;
    setConcLoadingMore(true);
    try {
      const next = concPlan.docs.slice(concLoaded, concLoaded + CONC_BATCH);
      const groups = await loadConcordanceGroups(client, concPlan.hitIds, next);
      if (concReq.current !== my) return;
      setConcGroups((prev) => [...prev, ...groups]);
      setConcLoaded((prev) => prev + next.length);
    } catch (err) {
      console.error('Load more concordance failed:', err);
    } finally {
      loadingMoreRef.current = false;
      if (concReq.current === my) setConcLoadingMore(false);
    }
  };
  loadMoreRef.current = loadMore;

  // Auto-load more when the sentinel scrolls into view.
  useEffect(() => {
    if (!concHasMore) return undefined;
    const el = sentinelRef.current;
    if (!el) return undefined;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMoreRef.current();
      },
      { rootMargin: '300px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [concHasMore, concLoaded]);

  // Measure the pane's top (the two-pane row is normal-flow, so this is the
  // sticky pane's natural top) and cap the pane to reach the viewport bottom.
  useLayoutEffect(() => {
    const measure = () => {
      const el = paneWrapRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      // Subtract the page wrapper's bottom padding (py-8 = 2rem) too, so a left
      // pane that's the tallest element doesn't push the document a few px past
      // the viewport (a tiny page scroll). Ceil for sub-pixel safety.
      setPaneMaxH(`calc(100vh - ${Math.max(0, Math.ceil(top))}px - 2rem)`);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const selectItem = (item) => {
    setSelectedId(item.id);
    setEditForm(item.form);
    setEditFields(item.metadata || {});
  };

  const startNew = () => {
    setSelectedId(NEW_ID);
    setEditForm('');
    setEditFields({});
  };

  const cancelEdit = () => {
    if (isNew) {
      setSelectedId(null);
      setEditForm('');
      setEditFields({});
    } else if (selectedItem) {
      setEditForm(selectedItem.form);
      setEditFields(selectedItem.metadata || {});
    }
  };

  const dirty = isNew
    ? editForm.trim() !== '' || Object.keys(cleanMeta(editFields)).length > 0
    : !!selectedItem &&
      (editForm.trim() !== selectedItem.form ||
        !metaEqual(editFields, selectedItem.metadata || {}));

  // Switching away with unsaved edits would silently discard them — confirm first.
  const applyTarget = (target) => {
    if (target?.type === 'new') startNew();
    else if (target?.type === 'item') selectItem(target.item);
  };
  const attemptSelect = (item) => {
    if (item.id === selectedId) return; // already open
    if (dirty) {
      setPendingTarget({ type: 'item', item });
      setDiscardOpen(true);
    } else selectItem(item);
  };
  const attemptNew = () => {
    if (dirty) {
      setPendingTarget({ type: 'new' });
      setDiscardOpen(true);
    } else startNew();
  };

  const handleSave = async () => {
    if (!editForm.trim()) {
      notifyError('Item form cannot be empty', 'Invalid Form');
      return;
    }
    try {
      const metadata = cleanMeta(editFields);
      if (isNew) {
        const created = await client.vocabItems.create(
          vocabularyId,
          editForm.trim(),
          Object.keys(metadata).length ? metadata : undefined,
        );
        await fetchItems();
        if (created?.id) {
          setSelectedId(created.id);
          setEditForm(editForm.trim());
        } else {
          setSelectedId(null);
        }
        notifySuccess('Vocabulary item created successfully', 'Success');
      } else {
        const item = selectedItem;
        if (editForm.trim() !== item.form) {
          await client.vocabItems.update(item.id, editForm.trim());
        }
        if (Object.keys(metadata).length > 0) {
          await client.vocabItems.setMetadata(item.id, metadata);
        } else if (item.metadata && Object.keys(item.metadata).length > 0) {
          await client.vocabItems.deleteMetadata(item.id);
        }
        await fetchItems();
        setEditForm(editForm.trim());
        notifySuccess('Vocabulary item updated successfully', 'Success');
      }
    } catch (err) {
      console.error('Error saving vocabulary item:', err);
      notifyError('Failed to save vocabulary item', 'Error');
    }
  };

  const handleConfirmDelete = async () => {
    if (!selectedItem) return;
    try {
      await client.vocabItems.delete(selectedItem.id);
      setDeleteOpen(false);
      setSelectedId(null);
      setEditForm('');
      setEditFields({});
      await fetchItems();
      notifySuccess('Vocabulary item deleted successfully', 'Success');
    } catch (err) {
      console.error('Error deleting vocabulary item:', err);
      notifyError('Failed to delete vocabulary item', 'Error');
    }
  };

  // ---- TSV export (Form + every field + Uses) ----
  const handleExportTsv = () => {
    const tsv = serializeVocabTsv({
      items: filteredItems,
      fieldNames,
      fieldLabels: fieldNames.map(humanizeFieldName),
      usageCounts,
    });
    downloadBlob(
      `${sanitizeFilename(vocabulary?.name || 'vocabulary')}.tsv`,
      new Blob([tsv], { type: 'text/tab-separated-values;charset=utf-8' }),
    );
  };

  // ---- left list (search + sort by form) ----
  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = items;
    if (q) {
      list = items.filter(
        (it) =>
          it.form.toLowerCase().includes(q) ||
          fieldNames.some((f) =>
            String(it.metadata?.[f] ?? '')
              .toLowerCase()
              .includes(q),
          ),
      );
    }
    return [...list].sort((a, b) => {
      const af = a.form.toLowerCase();
      const bf = b.form.toLowerCase();
      if (af < bf) return -1;
      if (af > bf) return 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // homonyms in creation order
    });
  }, [items, search, fieldNames]);

  const pageCount = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageItems = filteredItems.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const rangeStart = filteredItems.length === 0 ? 0 : currentPage * PAGE_SIZE + 1;
  const rangeEnd = Math.min((currentPage + 1) * PAGE_SIZE, filteredItems.length);

  // Reset to page 1 when the result set is re-scoped; jump the list back to top
  // when the page changes.
  useEffect(() => {
    setPage(0);
  }, [search]);
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [currentPage]);

  const listCols = hasGloss
    ? 'grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_auto]'
    : 'grid-cols-[minmax(0,1fr)_auto]';

  // Field inputs for the detail editor (morphType is a controlled vocab).
  const renderFieldInputs = (values, onChange, disabled = false) =>
    fields.map((field) => (
      <div key={field.name} className="flex flex-col gap-1.5">
        <Label>{humanizeFieldName(field.name)}</Label>
        {field.name === 'morphType' ? (
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
            value={values.morphType || ''}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...values, morphType: event.target.value || undefined })
            }
          >
            <option value="">—</option>
            {FLEX_MORPH_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        ) : (
          <Input
            placeholder={`Enter ${humanizeFieldName(field.name).toLowerCase()}`}
            value={values[field.name] || ''}
            disabled={disabled}
            onChange={(event) => onChange({ ...values, [field.name]: event.target.value })}
          />
        )}
      </div>
    ));

  if (loading) {
    return (
      <div className="tw flex flex-col items-center gap-6 py-6">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-foreground" />
        <p className="text-sm">Loading vocabulary items...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="tw rounded-md border border-destructive/50 bg-destructive/5 p-3">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="text-sm">
            <p className="font-medium text-destructive">Error</p>
            <p className="mt-1 text-muted-foreground">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={paneWrapRef} className="tw flex items-start gap-4">
      {/* ---- left pane: item list ---- */}
      <div
        className="sticky top-4 flex max-h-[calc(100vh-14rem)] w-96 shrink-0 flex-col rounded-lg border bg-card"
        style={paneMaxH ? { maxHeight: paneMaxH } : undefined}
      >
        <div className="flex flex-col gap-2 border-b p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">
              Items{' '}
              <span className="text-muted-foreground">
                ({search ? `${filteredItems.length} of ${items.length}` : items.length})
              </span>
            </span>
            {canManage && (
              <Button size="sm" className="h-7" onClick={attemptNew}>
                <Plus className="h-3.5 w-3.5" /> New
              </Button>
            )}
          </div>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search items…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-7"
            />
          </div>
        </div>

        {items.length > 0 && filteredItems.length > 0 && (
          <div
            className={cn(
              'grid items-center gap-2 border-b px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground',
              listCols,
            )}
          >
            <span>Form</span>
            {hasGloss && <span>Gloss</span>}
            <span className="text-right">Uses</span>
          </div>
        )}

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              No items yet. Click “New”.
            </p>
          ) : filteredItems.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">No matches.</p>
          ) : (
            <ul className="divide-y">
              {pageItems.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => attemptSelect(item)}
                    className={cn(
                      'grid w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent/40',
                      listCols,
                      selectedId === item.id && 'bg-accent/60',
                    )}
                  >
                    <FormLabel
                      form={item.form}
                      index={homonyms.get(item.id)}
                      className="truncate font-medium"
                    />
                    {hasGloss && (
                      <span className="truncate text-xs text-muted-foreground">
                        {item.metadata?.gloss || ''}
                      </span>
                    )}
                    <span className="text-right text-xs tabular-nums text-muted-foreground">
                      {usageCounts ? (usageCounts[item.id] ?? 0) : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {pageCount > 1 && (
          <div className="flex items-center justify-between gap-1 border-t px-2 py-1.5 text-xs text-muted-foreground">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <span className="tabular-nums">
              {rangeStart}–{rangeEnd} of {filteredItems.length}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              disabled={currentPage >= pageCount - 1}
              onClick={() => setPage(currentPage + 1)}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}

        <div className="flex items-center gap-2 border-t p-2">
          {canManage && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 flex-1"
              onClick={() => setBulkOpen(true)}
            >
              <Upload className="h-3.5 w-3.5" /> Bulk Add
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 flex-1"
            onClick={handleExportTsv}
            disabled={!items.length}
          >
            <Download className="h-3.5 w-3.5" /> Export
          </Button>
        </div>
      </div>

      {/* ---- right pane: detail + concordance ---- */}
      <div className="min-w-0 flex-1">
        {!selectedId ? (
          <div className="flex min-h-[24rem] items-center justify-center rounded-lg border border-dashed bg-card/50">
            <p className="text-sm text-muted-foreground">
              Select an item, or click “New” to add one.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* detail editor */}
            <div className="rounded-lg border bg-card p-4">
              <div className="mb-3 flex items-start justify-between gap-2">
                <h3 className="text-base font-semibold">
                  {isNew ? (
                    'New item'
                  ) : (
                    <FormLabel
                      form={selectedItem?.form ?? ''}
                      index={homonyms.get(selectedItem?.id)}
                    />
                  )}
                </h3>
                {!isNew && selectedItem && (
                  <div className="text-right text-xs text-muted-foreground">
                    {(usageCounts?.[selectedItem.id] ?? 0).toLocaleString()} use
                    {(usageCounts?.[selectedItem.id] ?? 0) === 1 ? '' : 's'}
                    {usageKinds?.[selectedItem.id] && (
                      <span className="ml-1.5" title="Linked from this many words and morphemes">
                        ·{' '}
                        {['word', 'morpheme']
                          .filter((k) => usageKinds[selectedItem.id][k])
                          .map((k) => {
                            const n = usageKinds[selectedItem.id][k];
                            return `${n.toLocaleString()} ${k}${n === 1 ? '' : 's'}`;
                          })
                          .join(', ')}
                      </span>
                    )}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label>
                    Form <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    value={editForm}
                    autoFocus={isNew}
                    placeholder="Enter item form"
                    disabled={!canManage}
                    onChange={(e) => setEditForm(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        if (dirty) handleSave();
                      }
                    }}
                  />
                </div>
                {renderFieldInputs(editFields, setEditFields, !canManage)}
              </div>
              {!isNew && selectedItem && <ImportedExtras metadata={selectedItem.metadata} />}

              {canManage && (
                <div className="mt-4 flex items-center justify-between">
                  <div>
                    {!isNew && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleteOpen(true)}
                      >
                        <Trash2 className="h-4 w-4" /> Delete
                      </Button>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={cancelEdit} disabled={!dirty}>
                      Cancel
                    </Button>
                    <Button size="sm" onClick={handleSave} disabled={!dirty || !editForm.trim()}>
                      {isNew ? 'Create' : 'Save'}
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {/* concordance */}
            {!isNew && (
              <div className="rounded-lg border bg-card">
                <div className="flex items-center justify-between border-b px-4 py-2">
                  <span className="text-sm font-medium">Concordance</span>
                  {concPlan && (
                    <span className="text-xs text-muted-foreground">
                      {concPlan.totalHits.toLocaleString()} use{concPlan.totalHits === 1 ? '' : 's'}{' '}
                      in {concPlan.totalDocs} document{concPlan.totalDocs === 1 ? '' : 's'}
                      {concPlan.truncated ? ' (capped)' : ''}
                    </span>
                  )}
                </div>

                {concLoading ? (
                  <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted border-t-foreground" />
                    Loading usage examples…
                  </div>
                ) : concError ? (
                  <p className="px-4 py-6 text-center text-sm text-muted-foreground">{concError}</p>
                ) : !concPlan || concPlan.totalHits === 0 ? (
                  <p className="px-4 py-10 text-center text-sm text-muted-foreground">
                    Not linked to any words or morphemes yet.
                  </p>
                ) : (
                  <div className="flex flex-col gap-3 p-3">
                    {concGroups.map((g) => (
                      <div key={g.docId} className="overflow-hidden rounded-md border">
                        <div className="flex items-center gap-2 border-b bg-muted/50 px-3 py-1.5">
                          <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="text-sm font-medium">{g.docName}</span>
                          <span className="text-xs text-muted-foreground">
                            {g.docHits} use{g.docHits === 1 ? '' : 's'}
                          </span>
                        </div>
                        <div className="divide-y">
                          {g.rows.map((row) => {
                            // Deep-link the target sentence via query params so a
                            // new tab (middle/ctrl-click) lands on it too.
                            const to = g.projectId
                              ? `/projects/${g.projectId}/documents/${g.docId}?tab=analyze&focusSentence=${row.sentenceId}`
                              : null;
                            return (
                              <a
                                key={row.sentenceId}
                                href={to ? `#${to}` : undefined}
                                onClick={(e) => {
                                  if (!to) {
                                    e.preventDefault();
                                    return;
                                  }
                                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0)
                                    return; // let the browser open a new tab
                                  e.preventDefault();
                                  navigate(to);
                                }}
                                className="block w-full cursor-pointer px-3 py-1.5 text-left no-underline hover:bg-muted/50"
                                title={
                                  to ? 'Open in Analyze (middle-click for a new tab)' : undefined
                                }
                              >
                                <p className="text-sm text-foreground">
                                  <span className="mr-2 text-xs text-muted-foreground">
                                    #{row.sentenceIndex + 1}
                                  </span>
                                  <MarkedText text={row.text} marks={row.marks} />
                                </p>
                                {row.notes.length > 0 && (
                                  <p className="mt-0.5 text-xs text-violet-700">
                                    {[...new Set(row.notes)].join(' · ')}
                                  </p>
                                )}
                                {row.translation && (
                                  <p className="mt-0.5 text-xs italic text-muted-foreground">
                                    ‘{row.translation}’
                                  </p>
                                )}
                              </a>
                            );
                          })}
                          {g.rows.length === 0 && (
                            <p className="px-3 py-2 text-xs text-muted-foreground">
                              Uses in this document could not be located (it may have changed). Open
                              it to look.
                            </p>
                          )}
                        </div>
                      </div>
                    ))}

                    {concHasMore && (
                      <div ref={sentinelRef} className="flex justify-center py-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => loadMoreRef.current()}
                          disabled={concLoadingMore}
                        >
                          {concLoadingMore
                            ? 'Loading…'
                            : `Load more (${(concPlan.totalDocs - concLoaded).toLocaleString()} document${concPlan.totalDocs - concLoaded === 1 ? '' : 's'} left)`}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <BulkAddDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        vocabularyId={vocabularyId}
        vocabularyName={vocabulary?.name}
        fields={fields}
        existingItems={items}
        client={client}
        onImported={handleImported}
      />

      {/* Delete confirmation */}
      <AlertDialog
        open={deleteOpen}
        onOpenChange={(o) => {
          if (!o) setDeleteOpen(false);
        }}
      >
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Vocabulary Item</AlertDialogTitle>
          </AlertDialogHeader>
          <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div className="text-sm">
                <p className="font-medium text-destructive">Warning</p>
                <p className="mt-1 text-muted-foreground">
                  You are about to permanently delete the vocabulary item{' '}
                  <strong>"{selectedItem?.form}"</strong>.
                </p>
                <p className="mt-1 text-muted-foreground">
                  {usageCounts && (usageCounts[selectedItem?.id] ?? 0) > 0 ? (
                    <>
                      It is linked to{' '}
                      <strong>
                        {usageCounts[selectedItem.id]} word
                        {usageCounts[selectedItem.id] === 1 ? '' : 's'}/morpheme
                        {usageCounts[selectedItem.id] === 1 ? '' : 's'}
                      </strong>
                      . Those links will be removed.{' '}
                    </>
                  ) : null}
                  This action cannot be undone.
                </p>
              </div>
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteOpen(false)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleConfirmDelete}
            >
              <Trash2 className="h-4 w-4" /> Delete Item
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Discard-unsaved-changes confirmation */}
      <AlertDialog
        open={discardOpen}
        onOpenChange={(o) => {
          if (!o) {
            setDiscardOpen(false);
            setPendingTarget(null);
          }
        }}
      >
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
          </AlertDialogHeader>
          <p className="text-sm text-muted-foreground">
            You have unsaved edits to <strong>"{editForm || selectedItem?.form}"</strong>. Switching
            away will discard them.
          </p>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                setDiscardOpen(false);
                setPendingTarget(null);
              }}
            >
              Keep editing
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                applyTarget(pendingTarget);
                setDiscardOpen(false);
                setPendingTarget(null);
              }}
            >
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
