import { useState, useEffect, useId, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Plus,
  Trash2,
  AlertTriangle,
  Upload,
  Download,
  FileText,
  MessageSquare,
  Replace,
  List,
  ListTree,
  Quote,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { SearchInput, ListCount, ListPager, SortHeader } from '@/components/ui/list-search';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { pageSlice, pageKey, useResetOnChange, LIST_PAGE_SIZE } from '@/hooks/usePagedList';
import { listPrefKey, useStickyState, useStickySort } from '@/hooks/useStickyState';
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
import { morphTypeLabel, morphTypeOptions } from '@/domain/affixMarkers';
import {
  humanizeFieldName,
  fieldLabel,
  groupFieldsForForm,
  editableMetadata,
  reservedMetadata,
  vocabTagsetByField,
  FIELD_TYPES,
} from '@/domain/vocabFields';
import {
  buildSenseTree,
  buildItemNumbers,
  arrangeAsTree,
  fieldsForItem,
  validateVocabRefs,
  planDeleteRefs,
  planSenseDrop,
  homographGroup,
  planHomographOrder,
  withParentSet,
  withExampleAdded,
  withExampleRemoved,
  STATUS_FIELD,
} from '@/domain/vocabDictionary';
import {
  ItemRefField,
  EntryPlace,
  HomographNumber,
  HomographDialog,
  ReferencedByPanel,
  ExamplesPanel,
  ContextRow,
} from './DictionaryPanels';
import { validateValue } from '@/domain/tagsets';
import { TagsetField, changedValuesAllowed } from '@/components/shared/TagsetField.jsx';
import { buildHomonymIndex } from '@/domain/vocabHomonyms';
import { FormLabel } from './FormLabel';
import { planItemConcordance, loadConcordanceGroups, sentenceTo } from './vocabConcordance';
import { serializeVocabTsv } from '@/export/vocabTsv';
import { BulkAddDialog } from './BulkAddDialog';
import { ReplaceDialog } from './ReplaceDialog';
import { filterVocabItems, sortVocabItems, fieldEmpty, ANY_FIELD } from '@/domain/vocabItemFilter';
import { EntryComments } from './EntryComments';
import { useCommentStore } from '@/domain/useCommentStore';
import { anchorCaption } from '@/domain/commentAnchors';
import { downloadBlob, sanitizeFilename } from '@/export/files';

const NEW_ID = '__new__';

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

// The example sentences a FLEx import stores outside the field schema
// (metadata.examples is structured, so it is never a field column). A
// dictionary vocabulary has its own Examples panel, which shows these too,
// so it hides them here.
const ImportedExtras = ({ metadata, showExamples = true }) => {
  const examples =
    showExamples && Array.isArray(metadata?.examples)
      ? metadata.examples.filter((ex) => ex && ex.text)
      : [];
  if (!examples.length) return null;
  return (
    <div className="mt-4 flex flex-col gap-2 border-t pt-3 text-sm">
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
    </div>
  );
};

// A titled band of the entry form. The grid is three across when the pane is
// wide, so a lexicon's dozen fields fit on one screen. Module-level, so a
// keystroke in a field does not remount the band it sits in.
const FormGroup = ({ title, children }) => (
  <div className="flex flex-col gap-2">
    {title && (
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
    )}
    <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">{children}</div>
  </div>
);

// The columns this list sorts by, named once so a remembered sort on a column
// that is no longer here is rejected rather than reaching the comparator.
const ITEM_COLUMNS = ['form', 'gloss', 'uses'];

export const VocabularyItems = ({
  vocabularyId,
  vocabulary,
  client,
  fields,
  canManage = true,
  comments = null,
  canComment = false,
  dictionary = false,
}) => {
  // Prefix for the detail editor's input ids, so every label addresses its own
  // field (clicking the label focuses it) even with another copy on the page.
  const uid = useId();
  // Re-render on comment changes, so the per-entry counts stay in step.
  useCommentStore(comments);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // The open entry lives in `?item=` (`new` while creating one), so a reload,
  // the back button, and a link sent to someone all land on the same entry, and
  // each row in the list can be a real link. The inline edit draft below
  // follows whatever the URL points at (NEW_ID = unsaved new item).
  const [searchParams, setSearchParams] = useSearchParams();
  const itemParam = searchParams.get('item');
  const selectedId = itemParam === 'new' ? NEW_ID : itemParam;
  const [editForm, setEditForm] = useState('');
  const [editFields, setEditFields] = useState({});
  // Confirm before discarding unsaved edits on a selection switch.
  const [discardOpen, setDiscardOpen] = useState(false);
  const [pendingTarget, setPendingTarget] = useState(null); // item id | NEW_ID | null

  // `?item=` for one entry, keeping whatever else is on the URL (`?tab=`).
  // `?parent=` rides with `?item=new` only: "Add sense" opens the new-entry
  // form under an entry, and the entry it creates is a sense of that one.
  const itemQuery = (id, parent = null) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('item', id === NEW_ID ? 'new' : id);
    else next.delete('item');
    if (id === NEW_ID && parent) next.set('parent', parent);
    else next.delete('parent');
    const q = next.toString();
    return q ? `?${q}` : '';
  };
  const itemTo = (id) => ({ search: itemQuery(id) });
  const newSenseTo = (parentId) => ({ search: itemQuery(NEW_ID, parentId) });
  const goItem = (id, options) => setSearchParams(itemQuery(id).replace(/^\?/, ''), options);
  const newParent = itemParam === 'new' ? searchParams.get('parent') : null;

  // Left-list search, pagination, usage counts, bulk add, delete confirm.
  const [search, setSearch] = useState('');
  // Which column the search box reads: every one, or a single field. Scoped
  // to a field, the box can instead show the entries with nothing in it.
  const [searchField, setSearchField] = useState(ANY_FIELD);
  const [emptyOnly, setEmptyOnly] = useState(false);
  // The column the list is ordered by; a heading click sorts by it or flips it.
  const [sort, onSort] = useStickySort(
    listPrefKey('sort', 'vocab-items', vocabularyId),
    { key: 'form', dir: 'asc' },
    ITEM_COLUMNS,
  );
  const [page, setPage] = useStickyState(
    pageKey('vocab-items', vocabularyId),
    0,
    (v) => Number.isInteger(v) && v >= 0,
  );
  const listRef = useRef(null);
  // Size the sticky left pane to fit from its own top to the viewport bottom, so
  // its footer is always visible without scrolling — measured (not a guessed
  // chrome constant) so it's immune to breadcrumb wrapping / zoom / etc.
  const paneWrapRef = useRef(null);
  const [paneMaxH, setPaneMaxH] = useState(null);
  const [usageCounts, setUsageCounts] = useState(null); // {itemId: n} | null
  const [usageKinds, setUsageKinds] = useState(null); // {itemId: {word: n, morpheme: n}} | null
  const [bulkOpen, setBulkOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
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
  // How entries are told apart: dotted numbers in Lexicography Mode ("a 1.2"),
  // homonym subscripts (a₂) otherwise. Same map, either way, wherever an
  // entry is named.
  const homonyms = useMemo(
    () => (dictionary ? buildItemNumbers(items) : buildHomonymIndex(items)),
    [items, dictionary],
  );
  // The sense tree, and whether the list draws it. Only a dictionary has one.
  const tree = useMemo(() => buildSenseTree(items), [items]);
  const [treeViewPref, setTreeView] = useStickyState(
    listPrefKey('view', 'vocab-items', vocabularyId),
    false,
    (v) => typeof v === 'boolean',
  );
  const treeView = dictionary && treeViewPref;

  // field name -> the tagset governing it, the vocabulary's own (see
  // vocabFields.js). Everything below that judges a value asks this.
  const tagsetByField = useMemo(
    () => vocabTagsetByField(fields, vocabulary?.config),
    [fields, vocabulary],
  );
  const tagsetFor = useCallback((name) => tagsetByField.get(name) ?? null, [tagsetByField]);
  // Entries holding a value their field's tagset refuses (or a stray
  // delimiter). Every entry is already in memory, so the count is exact and
  // costs nothing, where the project needs a Validation tab and a query.
  const offTagsetIds = useMemo(() => {
    const out = new Set();
    if (!tagsetByField.size) return out;
    for (const it of items) {
      for (const [name, tagset] of tagsetByField) {
        if (validateValue(String(it.metadata?.[name] ?? ''), tagset).length) {
          out.add(it.id);
          break;
        }
      }
    }
    return out;
  }, [items, tagsetByField]);
  const [offTagsetOnly, setOffTagsetOnly] = useState(false);
  // How many entries have nothing in the scoped field. The form is never
  // empty, so the count (and its chip) only exist for a real field.
  const emptyField =
    searchField && searchField !== ANY_FIELD && searchField !== 'form' ? searchField : null;
  const emptyCount = useMemo(
    () => (emptyField ? items.filter((it) => fieldEmpty(it, emptyField)).length : 0),
    [items, emptyField],
  );
  useEffect(() => {
    if (!emptyField || emptyCount === 0) setEmptyOnly(false);
  }, [emptyField, emptyCount]);

  const selectedItem = useMemo(
    () =>
      selectedId && selectedId !== NEW_ID ? items.find((i) => i.id === selectedId) || null : null,
    [items, selectedId],
  );
  const isNew = selectedId === NEW_ID;

  // `quiet`: refresh the list without the full-pane spinner. The spinner
  // replaces the whole two-pane layout, so using it for a refresh AFTER an edit
  // tears down the list and the open editor, losing scroll position and focus
  // for a change the user already sees. Only the first load earns it.
  const fetchItems = async ({ quiet = false } = {}) => {
    try {
      if (!quiet) setLoading(true);
      if (!client) throw new Error('Not authenticated');
      if (!vocabularyId || vocabularyId === 'undefined' || vocabularyId === 'new') {
        throw new Error('Invalid vocabulary ID');
      }
      const vocabularyData = await client.vocabLayers.get(vocabularyId, true);
      const fetched = vocabularyData.items || [];
      setItems(fetched);
      setError('');
      fetchUsageCounts(); // not awaited
      repairRefs(fetched); // not awaited
      return fetched;
    } catch (err) {
      setError('Failed to load entries');
      console.error('Error fetching vocabulary items:', err);
      return null;
    } finally {
      if (!quiet) setLoading(false);
    }
  };

  // A bulk import can fill in the very item the detail editor has open, which
  // would leave its draft showing pre-import values (and looking dirty against
  // the refreshed item). Re-seed the draft from what came back, unless the
  // user really does have unsaved edits, which stay theirs.
  const handleImported = async () => {
    const wasDirty = dirty;
    const openId = selectedId;
    // Let the seeding effect re-fill the draft from what came back, unless the
    // user really does have unsaved edits, which stay theirs.
    if (!wasDirty) seededRef.current = undefined;
    const refreshed = await fetchItems({ quiet: true });
    if (wasDirty || !openId || openId === NEW_ID || !refreshed) return;
    if (!refreshed.some((i) => i.id === openId)) goItem(null, { replace: true });
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

  // Write one entry's metadata, the way the editor does: the whole map, or
  // none. Returns the entry as the list holds it.
  const writeMetadata = async (id, metadata) => {
    if (Object.keys(metadata).length) await client.vocabItems.setMetadata(id, metadata);
    else await client.vocabItems.deleteMetadata(id);
  };
  const foldPatches = (patches) => {
    const byId = new Map(patches.map((p) => [p.id, p.metadata]));
    setItems((prev) =>
      prev.map((it) => {
        if (!byId.has(it.id)) return it;
        const metadata = byId.get(it.id);
        const rest = { ...it };
        delete rest.metadata;
        return Object.keys(metadata).length ? { ...rest, metadata } : rest;
      }),
    );
  };

  // A reference that points at an entry no longer here (deleted through the
  // API, or by another app) is cleared on the first load by someone who can
  // write, under one operation. Once per mount: after a repair there is
  // nothing left to repair.
  const repairedRef = useRef(false);
  const repairRefs = async (fetched) => {
    if (!dictionary || !canManage || repairedRef.current) return;
    repairedRef.current = true;
    const { patches, findings } = validateVocabRefs(fetched, fields);
    if (!patches.length) return;
    try {
      await client.withOperation('Repair entry references', async () => {
        for (const p of patches) await writeMetadata(p.id, p.metadata);
      });
      foldPatches(patches);
      if (findings.length) {
        console.group('Vocabulary references repaired');
        for (const f of findings) console.info(f.form, f.id, f.reasons.join('; '));
        console.groupEnd();
        notifyWarning(
          `${findings.length} entr${findings.length === 1 ? 'y' : 'ies'} pointed at entries that no longer exist. Those references were removed.`,
          'References repaired',
        );
      }
    } catch (err) {
      console.error('Repairing references failed:', err);
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

  // The edit draft follows the selection: seed it from the entry the URL names
  // whenever that changes (and once its data has arrived). `seededRef` records
  // what the draft was last filled from, so a re-fetch of the SAME entry leaves
  // the user's typing alone; the places that do want a re-seed (a save, a bulk
  // import) clear it first.
  const seededRef = useRef(undefined);
  useEffect(() => {
    if (seededRef.current === selectedId) return;
    if (!selectedId || selectedId === NEW_ID) {
      seededRef.current = selectedId;
      setEditForm('');
      setEditFields({});
      return;
    }
    const item = items.find((i) => i.id === selectedId);
    if (!item) return; // not loaded yet (or gone); leave the draft as it is
    seededRef.current = selectedId;
    setEditForm(item.form);
    setEditFields(editableMetadata(item.metadata));
  }, [selectedId, items]);

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

  const cancelEdit = () => {
    if (isNew) {
      // Replace: cancelling a draft undoes the step that opened it, so Back
      // should not walk into the abandoned form.
      goItem(null, { replace: true });
    } else if (selectedItem) {
      setEditForm(selectedItem.form);
      setEditFields(editableMetadata(selectedItem.metadata));
    }
  };

  const dirty = isNew
    ? editForm.trim() !== '' || Object.keys(cleanMeta(editFields)).length > 0
    : !!selectedItem &&
      (editForm.trim() !== selectedItem.form ||
        !metaEqual(editFields, editableMetadata(selectedItem.metadata)));
  // Only a CHANGED value is held to its tagset, so an off-tagset value an
  // import left behind does not lock the entry (see changedValuesAllowed).
  const saveAllowed = changedValuesAllowed(
    fields,
    editFields,
    (f) => tagsetFor(f.name),
    isNew ? {} : editableMetadata(selectedItem?.metadata),
  );

  // Switching away with unsaved edits would silently discard them — confirm
  // first. The rows are links, so this only intercepts the plain click that
  // would lose the draft: a modified click opens a new browser tab and leaves
  // this one (draft and all) exactly as it was.
  const isModifiedClick = (e) => e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
  const guardSelect = (e, id) => {
    if (isModifiedClick(e)) return;
    if (id === selectedId) {
      e.preventDefault(); // already open
      return;
    }
    if (dirty) {
      e.preventDefault();
      setPendingTarget(id);
      setDiscardOpen(true);
    }
  };

  const handleSave = async () => {
    if (!editForm.trim()) {
      notifyError('The form cannot be empty', 'Invalid Form');
      return;
    }
    if (!saveAllowed) {
      notifyError('A field holds a value its tagset does not accept.', 'Not saved');
      return;
    }
    try {
      // The structure the form does not edit (sense place, examples, import
      // identity) is carried over from the entry as it is NOW, so a renumber
      // or an example added while the form was open is not written back
      // over by this save.
      const metadata = {
        ...(isNew ? {} : reservedMetadata(selectedItem?.metadata)),
        ...cleanMeta(editFields),
      };
      const form = editForm.trim();
      // The saved entry is folded into `items` locally rather than re-fetching
      // the vocabulary: a re-fetch pulls every entry in the lexicon back over
      // the wire (thousands, for a FLEx import) to learn what we just wrote,
      // and re-seats the whole tab while it is in flight. `items` carries the
      // server's shape, so the patch mirrors it: no `metadata` key at all when
      // there is none, since that is what the API returns.
      const saved = (id, meta = metadata) => ({
        id,
        layer: vocabularyId,
        form,
        ...(Object.keys(meta).length ? { metadata: meta } : {}),
      });
      if (isNew) {
        const withPlace =
          dictionary && newParent && tree.byId.has(newParent)
            ? withParentSet(tree, { metadata }, newParent)
            : metadata;
        const created = await client.vocabItems.create(
          vocabularyId,
          form,
          Object.keys(withPlace).length ? withPlace : undefined,
        );
        if (created?.id) setItems((prev) => [...prev, saved(created.id, withPlace)]);
        // Replace: the `?item=new` step becomes the entry it created, so Back
        // does not return to an empty form for an entry that now exists.
        goItem(created?.id || null, { replace: true });
        if (created?.id) setEditForm(form);
        notifySuccess('Entry created', 'Success');
      } else {
        const item = selectedItem;
        if (form !== item.form) {
          await client.vocabItems.update(item.id, form);
        }
        if (Object.keys(metadata).length > 0) {
          await client.vocabItems.setMetadata(item.id, metadata);
        } else if (item.metadata && Object.keys(item.metadata).length > 0) {
          await client.vocabItems.deleteMetadata(item.id);
        }
        setItems((prev) => prev.map((i) => (i.id === item.id ? saved(item.id) : i)));
        setEditForm(form);
        notifySuccess('Entry updated', 'Success');
      }
    } catch (err) {
      console.error('Error saving vocabulary item:', err);
      notifyError('Failed to save the entry', 'Error');
    }
  };

  // What deleting the open entry would touch besides itself: the senses under
  // it (which become entries) and the fields that name it (cleared), all in
  // the same operation as the delete.
  const deleteRefPatches = useMemo(
    () => (dictionary && selectedItem ? planDeleteRefs(items, fields, [selectedItem.id]) : []),
    [dictionary, items, fields, selectedItem],
  );
  const handleConfirmDelete = async () => {
    if (!selectedItem) return;
    try {
      const deletedId = selectedItem.id;
      if (deleteRefPatches.length) {
        await client.withOperation(`Delete entry "${selectedItem.form}"`, async () => {
          for (const p of deleteRefPatches) await writeMetadata(p.id, p.metadata);
          await client.vocabItems.delete(deletedId);
        });
        foldPatches(deleteRefPatches);
      } else {
        await client.vocabItems.delete(deletedId);
      }
      setDeleteOpen(false);
      goItem(null, { replace: true });
      setItems((prev) => prev.filter((i) => i.id !== deletedId));
      notifySuccess('Entry deleted', 'Success');
    } catch (err) {
      console.error('Error deleting vocabulary item:', err);
      notifyError('Failed to delete the entry', 'Error');
    }
  };

  // ---- dictionary: placing senses, examples ----
  // Each of these writes the entry's stored metadata, not the draft: the
  // draft is re-seeded from the result unless the user has unsaved edits,
  // which stay theirs.
  const commitMetadata = async (id, metadata, label) => {
    await client.withOperation(label, async () => writeMetadata(id, metadata));
    foldPatches([{ id, metadata }]);
  };
  // Make `id` a sense of `parentId` (last), or, with null, its own entry.
  const handleMoveUnder = async (id, parentId) => {
    const moving = tree.byId.get(id);
    if (!moving) return;
    try {
      await commitMetadata(
        id,
        withParentSet(tree, moving, parentId),
        parentId
          ? `Make "${moving.form}" a sense of "${tree.byId.get(parentId)?.form ?? ''}"`
          : `Make "${moving.form}" its own entry`,
      );
    } catch (err) {
      console.error('Moving the entry failed:', err);
      notifyError('Failed to move the entry', 'Error');
    }
  };
  // A drop in the sense tree: before or after a sense, into one, or out.
  const handleSenseDrop = async (id, target) => {
    const patches = planSenseDrop(tree, id, target);
    if (!patches.length) return;
    const moving = tree.byId.get(id);
    try {
      await client.withOperation(`Move "${moving?.form ?? ''}"`, async () => {
        for (const p of patches) await writeMetadata(p.id, p.metadata);
      });
      foldPatches(patches);
    } catch (err) {
      console.error('Moving the sense failed:', err);
      notifyError('Failed to move the sense', 'Error');
    }
  };
  // The entries spelled like the open one, reordered by dragging in the
  // homograph dialog: their numbers are written 1..n under one operation.
  const [homographOpen, setHomographOpen] = useState(false);
  const homographs = useMemo(
    () => (dictionary && selectedItem ? homographGroup(items, selectedItem.id) : []),
    [dictionary, items, selectedItem],
  );
  const handleHomographOrder = async (orderedIds) => {
    const patches = planHomographOrder(homographs, orderedIds);
    if (!patches.length) return;
    try {
      await client.withOperation(
        `Reorder the entries spelled "${homographs[0]?.form ?? ''}"`,
        async () => {
          for (const p of patches) await writeMetadata(p.id, p.metadata);
        },
      );
      foldPatches(patches);
    } catch (err) {
      console.error('Reordering homographs failed:', err);
      notifyError('Failed to reorder the entries', 'Error');
    }
  };
  const handleAddExample = async (docId, tokenId) => {
    if (!selectedItem) return;
    const next = withExampleAdded(selectedItem.metadata, { document: docId, token: tokenId });
    if (next === selectedItem.metadata) return;
    try {
      await commitMetadata(selectedItem.id, next, `Add an example to "${selectedItem.form}"`);
    } catch (err) {
      console.error('Adding the example failed:', err);
      notifyError('Failed to add the example', 'Error');
    }
  };
  const handleRemoveExample = async (index) => {
    if (!selectedItem) return;
    try {
      await commitMetadata(
        selectedItem.id,
        withExampleRemoved(selectedItem.metadata, index),
        `Remove an example from "${selectedItem.form}"`,
      );
    } catch (err) {
      console.error('Removing the example failed:', err);
      notifyError('Failed to remove the example', 'Error');
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

  // ---- left list (search + column sort) ----
  const filteredItems = useMemo(
    () =>
      sortVocabItems(
        filterVocabItems(offTagsetOnly ? items.filter((it) => offTagsetIds.has(it.id)) : items, {
          query: search,
          field: searchField,
          emptyOnly,
          fieldNames,
        }),
        sort,
        { homonyms, usageCounts },
      ),
    [
      items,
      search,
      searchField,
      emptyOnly,
      fieldNames,
      homonyms,
      usageCounts,
      sort,
      offTagsetOnly,
      offTagsetIds,
    ],
  );

  // The rows the list draws: in the tree view an entry's senses follow it,
  // indented, when they are in the result set too (see arrangeAsTree).
  const listRows = useMemo(
    () =>
      treeView
        ? arrangeAsTree(filteredItems, tree)
        : filteredItems.map((item) => ({ item, depth: 0 })),
    [treeView, filteredItems, tree],
  );

  // Paged with the shared helper rather than the hook: the selection effect
  // below needs to drive the page itself, so the state stays local.
  const paged = pageSlice(listRows, page);
  const currentPage = paged.page;

  // Reset to page 1 when the result set is re-scoped, and only then, so the
  // page this vocabulary was left on survives the mount; jump the list back to
  // top when the page changes.
  useResetOnChange(
    `${search}|${searchField}|${emptyOnly}|${offTagsetOnly}|${sort.key}|${sort.dir}|${treeView}`,
    () => setPage(0),
  );
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [currentPage]);

  // Keep the selected entry findable in the list: whenever the selection moves
  // to one that is not on the page being shown (a link from the Analyze
  // popover, a URL someone sent, a reload, the back button), turn to its page
  // and scroll it into view. The list itself is left alone — filtering it down
  // to the one entry would throw away the context a reader arrived to browse —
  // and a row that is already on screen is never nudged, so clicking through
  // the list keeps it still. Declared after the scroll-to-top above so it runs
  // after it in the same commit; a layout effect would be undone by that reset.
  const positionedRef = useRef(null);
  useEffect(() => {
    if (!selectedId || selectedId === NEW_ID || positionedRef.current === selectedId) return;
    const index = listRows.findIndex((r) => r.item.id === selectedId);
    if (index < 0) return; // not loaded yet, or the search box has it filtered out
    const wanted = Math.floor(index / LIST_PAGE_SIZE);
    if (currentPage !== wanted) {
      setPage(wanted);
      return; // scroll once the right page has rendered
    }
    positionedRef.current = selectedId;
    const row = listRef.current?.querySelector('[data-selected="true"]');
    const pane = listRef.current?.getBoundingClientRect();
    if (!row || !pane) return;
    const r = row.getBoundingClientRect();
    if (r.top < pane.top || r.bottom > pane.bottom) row.scrollIntoView({ block: 'center' });
  }, [selectedId, listRows, currentPage, setPage]);

  const listCols = hasGloss
    ? 'grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_auto]'
    : 'grid-cols-[minmax(0,1fr)_auto]';

  // One field input for the entry form. morphType is a controlled vocab, a
  // reference field a picker, a tagset field its own control, the rest text.
  const renderField = (field, values, onChange, disabled) => {
    // Index, not the field name: a name is free text and may not be a legal
    // id fragment.
    const fieldId = `${uid}-field-${fields.indexOf(field)}`;
    const label = fieldLabel(field);
    return (
      <div key={field.name} className="flex min-w-0 flex-col gap-1">
        <Label htmlFor={fieldId} className="text-xs font-medium text-muted-foreground">
          {label}
        </Label>
        {dictionary && field.type === FIELD_TYPES.ITEM ? (
          <ItemRefField
            id={fieldId}
            field={field}
            values={values}
            onChange={onChange}
            items={items}
            homonyms={homonyms}
            itemTo={itemTo}
            selfId={isNew ? null : selectedId}
            disabled={disabled}
          />
        ) : field.name === 'morphType' ? (
          <select
            id={fieldId}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
            value={values.morphType || ''}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...values, morphType: event.target.value || undefined })
            }
          >
            <option value="">—</option>
            {morphTypeOptions(values.morphType).map((t) => (
              <option key={t} value={t}>
                {morphTypeLabel(t)}
              </option>
            ))}
          </select>
        ) : tagsetFor(field.name) ? (
          <TagsetField
            id={fieldId}
            field={field}
            value={values[field.name] || ''}
            tagset={tagsetFor(field.name)}
            placeholder={label}
            className="h-8"
            spellCheck={false}
            disabled={disabled}
            onChange={(v) => onChange({ ...values, [field.name]: v })}
          />
        ) : (
          <Input
            compose
            id={fieldId}
            className="h-8"
            placeholder={label}
            spellCheck={false}
            value={values[field.name] || ''}
            disabled={disabled}
            onChange={(event) => onChange({ ...values, [field.name]: event.target.value })}
          />
        )}
      </div>
    );
  };

  // The fields the open entry shows (an entry-only field is left off a
  // sense's form), in the form's groups: built-ins, custom, references. A
  // dictionary's status field is lifted out to the header.
  const formGroups = useMemo(
    () =>
      groupFieldsForForm(
        // The draft carries no structure, so the entry's own place (or the
        // parent a new sense is being written under) says which fields show.
        fieldsForItem(
          fields,
          {
            metadata: isNew
              ? newParent
                ? { parent: newParent }
                : {}
              : reservedMetadata(selectedItem?.metadata),
          },
          dictionary,
        ),
        { statusField: dictionary ? STATUS_FIELD : null },
      ),
    [fields, isNew, newParent, selectedItem, dictionary],
  );

  if (loading) {
    return (
      <div className="tw flex flex-col items-center gap-6 py-6">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-foreground" />
        <p className="text-sm">Loading entries…</p>
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
              value={search}
              onChange={setSearch}
            />
            <Select value={searchField} onValueChange={setSearchField}>
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
          {dictionary && (
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
          )}
          {emptyField && emptyCount > 0 && (
            <button
              type="button"
              aria-pressed={emptyOnly}
              onClick={() => setEmptyOnly((v) => !v)}
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
              aria-pressed={offTagsetOnly}
              onClick={() => setOffTagsetOnly((v) => !v)}
              title={
                offTagsetOnly
                  ? 'Show every entry'
                  : 'Show only the entries with a value outside its tagset'
              }
              className={cn(
                'inline-flex w-fit items-center gap-1 rounded px-1.5 py-0.5 text-xs text-destructive hover:underline',
                offTagsetOnly ? 'bg-destructive/20' : 'bg-destructive/10',
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
              {search.trim() ? `No entries match “${search.trim()}”.` : 'No entries match.'}
            </p>
          ) : (
            <ul className="divide-y">
              {paged.pageItems.map(({ item, depth }) => (
                <li key={item.id}>
                  <Link
                    to={itemTo(item.id)}
                    onClick={(e) => guardSelect(e, item.id)}
                    data-selected={selectedId === item.id || undefined}
                    data-depth={depth || undefined}
                    className={cn(
                      'grid w-full items-center gap-2 px-3 py-2 text-left text-sm no-underline hover:bg-accent/40',
                      listCols,
                      selectedId === item.id && 'bg-accent/60',
                    )}
                    style={depth ? { paddingLeft: `${0.75 + depth * 1.25}rem` } : undefined}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <FormLabel
                        form={item.form}
                        index={homonyms.get(item.id)}
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
            <Button
              variant="ghost"
              size="sm"
              className="h-7 flex-1"
              onClick={() => setBulkOpen(true)}
            >
              <Upload className="h-3.5 w-3.5" /> Bulk Add
            </Button>
          )}
          {canManage && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 flex-1"
              onClick={() => setReplaceOpen(true)}
              disabled={!items.length}
            >
              <Replace className="h-3.5 w-3.5" /> Replace
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
                    'New entry'
                  ) : dictionary && homographs.length > 1 && !tree.parentOf.get(selectedId) ? (
                    <>
                      {selectedItem?.form ?? ''}
                      <HomographNumber
                        number={homonyms.get(selectedItem?.id)}
                        onOpen={() => setHomographOpen(true)}
                        className="ml-1 text-[0.85em] font-normal"
                      />
                    </>
                  ) : (
                    <FormLabel
                      form={selectedItem?.form ?? ''}
                      index={homonyms.get(selectedItem?.id)}
                    />
                  )}
                </h3>
                {formGroups.status && (
                  <div className="ml-auto mr-3 flex items-center gap-2">
                    <Label
                      htmlFor={`${uid}-status`}
                      className="text-xs font-medium text-muted-foreground"
                    >
                      Status
                    </Label>
                    <TagsetField
                      id={`${uid}-status`}
                      field={formGroups.status}
                      value={editFields[STATUS_FIELD] || ''}
                      tagset={tagsetFor(STATUS_FIELD)}
                      className="h-7 w-32 text-xs"
                      disabled={!canManage}
                      onChange={(v) => setEditFields({ ...editFields, [STATUS_FIELD]: v })}
                    />
                  </div>
                )}
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

              {dictionary && !isNew && selectedItem && (
                <div className="mb-3">
                  <EntryPlace
                    item={selectedItem}
                    tree={tree}
                    items={items}
                    homonyms={homonyms}
                    itemTo={itemTo}
                    canManage={canManage}
                    onMoveUnder={handleMoveUnder}
                    onDrop={handleSenseDrop}
                    onReorderHomographs={() => setHomographOpen(true)}
                    newSenseTo={newSenseTo}
                  />
                </div>
              )}
              {dictionary && isNew && newParent && tree.byId.has(newParent) && (
                <p className="mb-3 text-xs text-muted-foreground">
                  A new sense of <strong>{tree.byId.get(newParent).form}</strong>
                </p>
              )}

              <div className="flex flex-col gap-4 [&>*+*]:border-t [&>*+*]:pt-3">
                <FormGroup>
                  <div className="flex min-w-0 flex-col gap-1">
                    <Label
                      htmlFor={`${uid}-form`}
                      className="text-xs font-medium text-muted-foreground"
                    >
                      Form <span className="text-destructive">*</span>
                    </Label>
                    <Input
                      id={`${uid}-form`}
                      compose
                      className="h-8"
                      value={editForm}
                      autoFocus={isNew}
                      placeholder="Form"
                      spellCheck={false}
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
                  {formGroups.builtIn.map((f) =>
                    renderField(f, editFields, setEditFields, !canManage),
                  )}
                </FormGroup>
                {formGroups.custom.length > 0 && (
                  <FormGroup title="Fields">
                    {formGroups.custom.map((f) =>
                      renderField(f, editFields, setEditFields, !canManage),
                    )}
                  </FormGroup>
                )}
                {formGroups.refs.length > 0 && (
                  <FormGroup title="References">
                    {formGroups.refs.map((f) =>
                      renderField(f, editFields, setEditFields, !canManage),
                    )}
                  </FormGroup>
                )}
              </div>
              {!isNew && selectedItem && (
                <ImportedExtras metadata={selectedItem.metadata} showExamples={!dictionary} />
              )}

              {canManage && (
                <div className="mt-4 flex items-center justify-between">
                  <div>
                    {!isNew && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:text-destructive"
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
                    <Button
                      size="sm"
                      onClick={handleSave}
                      disabled={!dirty || !editForm.trim() || !saveAllowed}
                    >
                      {isNew ? 'Create' : 'Save'}
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {dictionary && !isNew && selectedItem && (
              <>
                <ExamplesPanel
                  item={selectedItem}
                  client={client}
                  linkedTokenIds={concPlan && !concPlan.truncated ? concPlan.hitIds : null}
                  canManage={canManage}
                  onRemove={handleRemoveExample}
                />
                <ReferencedByPanel
                  item={selectedItem}
                  items={items}
                  fields={fields}
                  homonyms={homonyms}
                  itemTo={itemTo}
                />
              </>
            )}

            {/* comments on this entry */}
            {!isNew && selectedItem && comments && (
              <div className="rounded-lg border bg-card">
                <div className="flex items-center justify-between border-b px-4 py-2">
                  <span className="text-sm font-medium">Comments</span>
                  {comments.countFor(selectedItem.id) > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {comments.countFor(selectedItem.id)}
                    </span>
                  )}
                </div>
                <div className="px-4 py-3">
                  <EntryComments
                    store={comments}
                    itemId={selectedItem.id}
                    caption={anchorCaption({
                      kind: 'entry',
                      label: selectedItem.form,
                      detail: hasGloss ? selectedItem.metadata?.gloss || '' : '',
                    })}
                    canWrite={canComment}
                    canDeleteAny={canManage}
                  />
                </div>
              </div>
            )}

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
                            // Deep-link the target sentence via query params, so
                            // the row is an ordinary link: a new tab lands on the
                            // same sentence.
                            const tokenId = row.tokenIds?.[0];
                            const chosen =
                              !!tokenId &&
                              (selectedItem?.metadata?.examples || []).some(
                                (ex) => ex?.document === g.docId && ex?.token === tokenId,
                              );
                            return (
                              <div key={row.sentenceId} className="flex items-start">
                                <ContextRow
                                  row={row}
                                  to={sentenceTo(g.projectId, g.docId, row.sentenceId)}
                                />
                                {dictionary && canManage && tokenId && (
                                  <button
                                    type="button"
                                    title={chosen ? 'Already an example' : 'Use as example'}
                                    aria-label="Use as example"
                                    disabled={chosen}
                                    onClick={() => handleAddExample(g.docId, tokenId)}
                                    className="mt-1.5 mr-2 rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
                                  >
                                    <Quote className="h-3.5 w-3.5" />
                                  </button>
                                )}
                              </div>
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

      {dictionary && homographs.length > 1 && (
        <HomographDialog
          open={homographOpen}
          onOpenChange={setHomographOpen}
          group={homographs}
          currentId={tree.rootOf.get(selectedId)}
          onReorder={handleHomographOrder}
        />
      )}

      <BulkAddDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        vocabularyId={vocabularyId}
        vocabularyName={vocabulary?.name}
        fields={fields}
        tagsetFor={tagsetFor}
        existingItems={items}
        client={client}
        onImported={handleImported}
      />

      <ReplaceDialog
        open={replaceOpen}
        onOpenChange={setReplaceOpen}
        vocabularyName={vocabulary?.name}
        fields={fields}
        tagsetFor={tagsetFor}
        items={items}
        homonyms={homonyms}
        client={client}
        onApplied={handleImported}
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
            <AlertDialogTitle>Delete entry</AlertDialogTitle>
          </AlertDialogHeader>
          <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div className="text-sm">
                <p className="font-medium text-destructive">Warning</p>
                <p className="mt-1 text-muted-foreground">
                  You are about to permanently delete the entry{' '}
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
                  {deleteRefPatches.length > 0 && (
                    <>
                      <strong>
                        {deleteRefPatches.length} entr{deleteRefPatches.length === 1 ? 'y' : 'ies'}
                      </strong>{' '}
                      refer to it. Its senses become entries of their own, and references to it are
                      removed.{' '}
                    </>
                  )}
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
              <Trash2 className="h-4 w-4" /> Delete entry
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
                goItem(pendingTarget);
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
