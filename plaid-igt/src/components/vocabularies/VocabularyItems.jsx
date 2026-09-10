import {
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useCallback,
  useReducer,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@ui/components/ui/tabs';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { useTabParam } from '@/hooks/useTabParam';
import { notifySuccess, notifyError, notifyWarning, isPermissionError } from '@/utils/feedback';
import {
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
  fieldsForItem,
  validateVocabRefs,
  planDeleteRefs,
  planSenseDrop,
  splitEntryLevel,
  nextSenseOrder,
  homographGroup,
  planHomographOrder,
  withParentSet,
  withExampleAdded,
  withExampleRemoved,
  statusFieldKey,
  itemLabel,
} from '@/domain/vocabDictionary';
import {
  HomographDialog,
  ReferencedByPanel,
  ExamplesPanel,
  NavGuardProvider,
} from './DictionaryPanels';
import { validateValue, changedValuesAllowed } from '@/domain/tagsets';
import { useItemConcordance } from './useItemConcordance';
import { serializeVocabTsv } from '@/export/vocabTsv';
import { BulkAddDialog } from './BulkAddDialog';
import { ReplaceDialog } from './ReplaceDialog';
import { fieldText, fieldEmpty } from '@/domain/vocabItemFilter';
import { EntryComments } from './EntryComments';
import { useCommentStore } from '@/domain/useCommentStore';
import { anchorCaption } from '@/domain/commentAnchors';
import { downloadBlob, sanitizeFilename } from '@/export/files';
import {
  NEW_ID,
  cleanMeta,
  emptyFieldOf,
  initialState,
  isDirty,
  reducer,
  seedKeyFor,
} from './vocabItemsState';
import { useEntryList } from './useEntryList';
import { EntryList } from './EntryList';
import { EntryEditor } from './EntryEditor';
import { ConcordancePanel } from './ConcordancePanel';
import { EntryDialogs } from './EntryDialogs';

// How many repairs ride in one batch. A batch is one transaction holding the
// vocabulary's write lock, so it is sized by how long that lock is held.
const REPAIR_CHUNK = 100;

// The Entries screen of a vocabulary. This component owns the data (the
// entries, their usage counts) and every write; the selection lives in the
// URL; the draft, the list's scope, and the open dialog live in one reducer
// (vocabItemsState.js); the list's order and paging in useEntryList; and the
// concordance in useItemConcordance. The panes are EntryList, EntryEditor,
// ConcordancePanel, and EntryDialogs.
export const VocabularyItems = ({
  vocabularyId,
  vocabulary,
  client,
  fields,
  canManage = true,
  comments = null,
  canComment = false,
}) => {
  // Re-render on comment changes, so the per-entry counts stay in step.
  useCommentStore(comments);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [usageCounts, setUsageCounts] = useState(null); // {itemId: n} | null
  const [usageKinds, setUsageKinds] = useState(null); // {itemId: {word: n, morpheme: n}} | null

  const [state, dispatch] = useReducer(reducer, initialState);
  const { draft, scope, dialog } = state;

  // The open entry lives in `?item=` (`new` while creating one), so a reload,
  // the back button, and a link sent to someone all land on the same entry, and
  // each row in the list can be a real link. The draft follows whatever the
  // URL points at (NEW_ID = unsaved new item).
  const [searchParams, setSearchParams] = useSearchParams();
  const itemParam = searchParams.get('item');
  const selectedId = itemParam === 'new' ? NEW_ID : itemParam;
  const isNew = selectedId === NEW_ID;
  const newParent = itemParam === 'new' ? searchParams.get('parent') : null;

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
  // The right pane's tab (`?pane=`): the entry itself, its concordance, or
  // its comments. The entry is the default and keeps the URL clean.
  const [pane, setPane] = useTabParam(['entry', 'concordance', 'comments'], 'entry', 'pane');
  const paneTo = (name) => {
    const next = new URLSearchParams(searchParams);
    if (name === 'entry') next.delete('pane');
    else next.set('pane', name);
    const q = next.toString();
    return { search: q ? `?${q}` : '' };
  };
  const navigate = useNavigate();
  const confirm = useConfirm();
  const goItem = (id, options, parent = null) =>
    setSearchParams(itemQuery(id, parent).replace(/^\?/, ''), options);

  // Size the sticky left pane to fit from its own top to the viewport bottom, so
  // its footer is always visible without scrolling. Measured (not a guessed
  // chrome constant) so it is immune to breadcrumb wrapping, zoom, and so on.
  const paneWrapRef = useRef(null);
  const [paneMaxH, setPaneMaxH] = useState(null);
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

  // The open entry's concordance, loaded a batch at a time.
  const conc = useItemConcordance({ client, vocabularyId, selectedId, skipId: NEW_ID });

  // ---- derived from the entries ----
  const fieldNames = useMemo(() => fields.map((f) => f.name), [fields]);
  const hasGloss = useMemo(() => fields.some((f) => f.name === 'gloss'), [fields]);
  // The editorial status field, by whatever name this vocabulary declares it.
  const statusKey = useMemo(() => statusFieldKey(fields), [fields]);
  // How entries are told apart: the dotted number ("a 1.2"), used wherever an
  // entry is named.
  const numbers = useMemo(() => buildItemNumbers(items), [items]);
  const tree = useMemo(() => buildSenseTree(items), [items]);
  // `?parent=` as the lexicon actually has it. A stale id (the entry was
  // deleted, or the link was pasted) names nothing, and the new entry is
  // written as a headword, so every reader of it agrees on that.
  const liveNewParent = newParent && tree.byId.has(newParent) ? newParent : null;

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
  // How many entries have nothing in the scoped field, and whether the
  // empty-only filter applies right now: it exists for a real field with
  // something to show, and is dropped by the reducer when the field changes.
  const emptyField = emptyFieldOf(scope.field);
  const emptyCount = useMemo(
    () => (emptyField ? items.filter((it) => fieldEmpty(it, emptyField)).length : 0),
    [items, emptyField],
  );
  const emptyOnly = scope.emptyOnly && !!emptyField && emptyCount > 0;

  const selectedItem = useMemo(
    () => (selectedId && !isNew ? items.find((i) => i.id === selectedId) || null : null),
    [items, selectedId, isNew],
  );
  const homographs = useMemo(
    () => (selectedItem ? homographGroup(items, selectedItem.id) : []),
    [items, selectedItem],
  );

  // An Entry field holds ids. The screen shows the entries they name, so the
  // search box reads the same thing rather than an id nobody types.
  const searchTextOf = useMemo(() => {
    const refs = new Set(fields.filter((f) => f.type === FIELD_TYPES.ITEM).map((f) => f.name));
    if (!refs.size) return fieldText;
    const byId = new Map(items.map((it) => [it.id, it]));
    const nameOf = (id) => itemLabel(byId.get(id), numbers);
    return (item, name) => {
      if (!refs.has(name)) return fieldText(item, name);
      const v = item.metadata?.[name];
      return (Array.isArray(v) ? v : v ? [v] : []).map(nameOf).filter(Boolean).join(' ');
    };
  }, [fields, items, numbers]);

  const list = useEntryList({
    vocabularyId,
    items,
    scope,
    emptyOnly,
    offTagsetIds,
    fieldNames,
    searchTextOf,
    numbers,
    usageCounts,
    tree,
    selectedId,
  });

  // ---- loading ----
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

  // ---- writes ----
  // Write one entry's metadata, the way the editor does: the whole map, or
  // none.
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

  // The draft as of the latest render, for the async writes below that finish
  // a round trip later and need to know what the form was filled from.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // A reference that points at an entry no longer here (deleted through the
  // API, or by another app) is cleared on the first load by someone who can
  // write, under one operation. Once per mount: after a repair there is
  // nothing left to repair.
  const repairedRef = useRef(false);
  const repairRefs = async (fetched) => {
    if (!canManage || repairedRef.current) return;
    repairedRef.current = true;
    const { patches, findings } = validateVocabRefs(fetched, fields);
    if (!patches.length) return;
    try {
      await client.withOperation('Repair entry references', async () => {
        // Batched rather than one request each: a vocabulary that has lost a
        // pile of entries has as many writes as it has references to them.
        // Chunked, since one batch is one transaction holding the write lock.
        for (let i = 0; i < patches.length; i += REPAIR_CHUNK) {
          await client.batched(async () => {
            for (const p of patches.slice(i, i + REPAIR_CHUNK)) {
              if (Object.keys(p.metadata).length) client.vocabItems.setMetadata(p.id, p.metadata);
              else client.vocabItems.deleteMetadata(p.id);
            }
          });
        }
      });
      // The repair lands a round trip after the draft was seeded, so an entry
      // it touched is re-seeded from the repaired metadata. Left alone the
      // form still holds the cleared value and a Save writes it back.
      if (patches.some((p) => p.id === draftRef.current.seedKey)) {
        dispatch({ type: 'draft/unseed' });
      }
      foldPatches(patches);
      if (findings.length) {
        console.group('Vocabulary references repaired');
        for (const f of findings) console.info(f.form, f.id, f.reasons.join('; '));
        console.groupEnd();
        // Not always a deleted entry: a field changed to Entry holds text that
        // names no entry either, and this is what clears it.
        notifyWarning(
          `${findings.length} entr${findings.length === 1 ? 'y' : 'ies'} held a value that names no entry. Those values were cleared.`,
          'Entries repaired',
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
    // Runs once per vocabulary; the loader reads the client fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vocabularyId]);

  // The draft follows the selection: seed it from the entry the URL names
  // whenever that changes (and once its data has arrived). The reducer keeps
  // what the draft was last filled from, so a re-fetch of the SAME entry
  // leaves the user's typing alone; the writes that do want a re-seed (a
  // save, an import, a repair) unseed it first.
  useEffect(() => {
    const seedKey = seedKeyFor(selectedId, newParent);
    if (draft.seedKey === seedKey) return;
    if (!selectedId || selectedId === NEW_ID) {
      // A sense is spelled like its headword (a FLEx import gives every
      // sense the entry's form, and "adidi 1.2" reads that way), so Add sense
      // starts from that form. A new entry starts blank.
      const parent = newParent && tree.byId.get(newParent);
      dispatch({ type: 'draft/seed', seedKey, form: parent?.form ?? '', fields: {} });
      return;
    }
    const item = items.find((i) => i.id === selectedId);
    if (!item) return; // not loaded yet (or gone); leave the draft as it is
    dispatch({
      type: 'draft/seed',
      seedKey,
      form: item.form,
      fields: editableMetadata(item.metadata),
    });
  }, [selectedId, newParent, items, tree, draft.seedKey]);

  const dirty = isNew ? isDirty(draft, null) : selectedItem ? isDirty(draft, selectedItem) : false;
  // Only a CHANGED value is held to its tagset, so an off-tagset value an
  // import left behind does not lock the entry (see changedValuesAllowed).
  const saveAllowed = changedValuesAllowed(
    fields,
    draft.fields,
    (f) => tagsetFor(f.name),
    isNew ? {} : editableMetadata(selectedItem?.metadata),
  );

  const cancelEdit = () => {
    if (isNew) {
      // Replace: cancelling a draft undoes the step that opened it, so Back
      // should not walk into the abandoned form.
      goItem(null, { replace: true });
    } else if (selectedItem) {
      dispatch({
        type: 'draft/reset',
        form: selectedItem.form,
        fields: editableMetadata(selectedItem.metadata),
      });
    }
  };

  // Switching away with unsaved edits would silently discard them: the
  // discard dialog asks first. The rows are links, so this only intercepts
  // the plain click that would lose the draft: a modified click opens a new
  // browser tab and leaves this one (draft and all) exactly as it was.
  const isModifiedClick = (e) => e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
  const guardSelect = (e, id, parent = null) => {
    if (isModifiedClick(e)) return;
    // `?parent=` gives NEW_ID two destinations: a new entry, and a new sense of
    // some entry. Only the one on screen is already open, or New would do
    // nothing while an Add sense form is up.
    const sameTarget = id === selectedId && (parent ?? null) === (id === NEW_ID ? newParent : null);
    if (sameTarget) {
      e.preventDefault(); // already open
      return;
    }
    if (dirty) {
      e.preventDefault();
      dispatch({ type: 'dialog/askDiscard', target: { id, parent } });
    }
  };
  // A link that leaves this screen altogether (a concordance row, an example)
  // would discard the draft with no dialog at all, so it asks the same way.
  const guardLeave = (e, to) => {
    if (isModifiedClick(e) || !dirty) return;
    e.preventDefault();
    dispatch({ type: 'dialog/askDiscard', target: { to } });
  };
  // The same guards for the links inside the dictionary panels, which open
  // another entry exactly as a row does.
  const navGuard = useMemo(
    () => ({
      select: (e, id) => guardSelect(e, id),
      newSense: (e, parentId) => guardSelect(e, NEW_ID, parentId),
      leave: guardLeave,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedId, newParent, dirty],
  );
  // Where a confirmed discard goes: off the screen, or to the entry asked for.
  const discardTo = (target) => {
    if (target?.to) navigate(target.to);
    else goItem(target?.id ?? null, undefined, target?.parent ?? null);
  };

  // A bulk import can fill in the very item the detail editor has open, which
  // would leave its draft showing pre-import values (and looking dirty against
  // the refreshed item). Re-seed the draft from what came back, unless the
  // user really does have unsaved edits, which stay theirs.
  const handleImported = async () => {
    const wasDirty = dirty;
    const openId = selectedId;
    if (!wasDirty) dispatch({ type: 'draft/unseed' });
    const refreshed = await fetchItems({ quiet: true });
    if (wasDirty || !openId || openId === NEW_ID || !refreshed) return;
    if (!refreshed.some((i) => i.id === openId)) goItem(null, { replace: true });
  };

  const handleSave = async () => {
    if (!draft.form.trim()) {
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
        ...cleanMeta(draft.fields),
      };
      const form = draft.form.trim();
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
        const withPlace = liveNewParent
          ? withParentSet(tree, { metadata }, liveNewParent)
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
        if (created?.id) dispatch({ type: 'draft/form', form });
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
        dispatch({ type: 'draft/form', form });
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
    () => (selectedItem ? planDeleteRefs(items, fields, [selectedItem.id]) : []),
    [items, fields, selectedItem],
  );
  // Only say the senses are freed when there are some: the count above covers
  // both them and the fields that name the entry.
  const deleteFreesSenses = !!tree.childrenOf.get(selectedItem?.id)?.length;
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
      dispatch({ type: 'dialog/close' });
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
  // A new headword over `id`, with the same form, taking its place: the
  // entry becomes that headword's first sense. How one meaning becomes two.
  const handleRaiseHeadword = async (id) => {
    const it = tree.byId.get(id);
    if (!it) return;
    // The split moves fields the form edits up to the new headword, so the
    // draft is re-seeded from what comes back. Unsaved typing goes with it.
    if (dirty && id === selectedId) {
      const ok = await confirm({
        title: 'Discard unsaved changes?',
        description: 'Adding a headword reloads this entry.',
        confirmLabel: 'Discard changes',
        destructive: true,
      });
      if (!ok) return;
    }
    try {
      let created = null;
      await client.withOperation(`Add a headword over "${it.form}"`, async () => {
        const above = tree.parentOf.get(id);
        const place = above
          ? { parent: above, senseOrder: it.metadata?.senseOrder ?? nextSenseOrder(tree, above) }
          : {};
        // What belongs to the ENTRY goes up with the new headword: its place
        // among the entries spelled alike, the FLEx entry it came from, and
        // every headword-only field. Left below, they would sit on a sense,
        // where the form does not even show them. The morph type and lexeme
        // form go to both: the interlinear line reads the morph type off the
        // item a token is linked to, which stays the sense.
        const { entry, sense } = splitEntryLevel(it.metadata, fields);
        const headMeta = { ...entry, ...place };
        created = await client.vocabItems.create(
          vocabularyId,
          it.form,
          Object.keys(headMeta).length ? headMeta : undefined,
        );
        await writeMetadata(id, { ...sense, parent: created.id, senseOrder: 1 });
      });
      // One GET to resync rather than folding the new entry in by hand. The
      // split moved the headword-only fields off this item, so the open draft
      // is re-seeded from what came back. Left alone it reads dirty without an
      // edit, and a Save would put those fields back on the sense.
      dispatch({ type: 'draft/unseed' });
      await fetchItems({ quiet: true });
    } catch (err) {
      console.error('Adding the headword failed:', err);
      notifyError('Failed to add the headword', 'Error');
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
      items: list.filteredItems,
      fieldNames,
      fieldLabels: fields.map(fieldLabel),
      usageCounts,
      refFields: fields.filter((f) => f.type === FIELD_TYPES.ITEM).map((f) => f.name),
      numbers,
    });
    downloadBlob(
      `${sanitizeFilename(vocabulary?.name || 'vocabulary')}.tsv`,
      new Blob([tsv], { type: 'text/tab-separated-values;charset=utf-8' }),
    );
  };

  // The fields the open entry shows (an entry-only field is left off a
  // sense's form), in the form's groups: built-ins, custom, references. The
  // status field is lifted out to the header.
  const formGroups = useMemo(
    () =>
      groupFieldsForForm(
        // The draft carries no structure, so the entry as stored (or the
        // parent a new sense is being written under) says which fields show.
        fieldsForItem(
          fields,
          isNew ? { metadata: liveNewParent ? { parent: liveNewParent } : {} } : selectedItem,
        ),
        { statusField: statusKey },
      ),
    [fields, isNew, liveNewParent, selectedItem, statusKey],
  );

  const entryEditor = (
    <EntryEditor
      fields={fields}
      items={items}
      numbers={numbers}
      tree={tree}
      selectedId={selectedId}
      selectedItem={selectedItem}
      isNew={isNew}
      liveNewParent={liveNewParent}
      draft={draft}
      dispatch={dispatch}
      dirty={dirty}
      saveAllowed={saveAllowed}
      canManage={canManage}
      tagsetFor={tagsetFor}
      statusKey={statusKey}
      formGroups={formGroups}
      homographs={homographs}
      usageCounts={usageCounts}
      usageKinds={usageKinds}
      itemTo={itemTo}
      newSenseTo={newSenseTo}
      onSave={handleSave}
      onCancel={cancelEdit}
      onDelete={() => dispatch({ type: 'dialog/open', kind: 'delete' })}
      onMoveUnder={handleMoveUnder}
      onRaiseHeadword={handleRaiseHeadword}
      onSenseDrop={handleSenseDrop}
      onOpenHomographs={() => dispatch({ type: 'dialog/open', kind: 'homograph' })}
    />
  );

  if (loading) {
    return (
      <div className="flex flex-col items-center gap-6 py-6">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-foreground" />
        <p className="text-sm">Loading entries…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3">
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
    <NavGuardProvider value={navGuard}>
      <div ref={paneWrapRef} className="flex items-start gap-4">
        <EntryList
          list={list}
          scope={scope}
          dispatch={dispatch}
          emptyOnly={emptyOnly}
          emptyField={emptyField}
          emptyCount={emptyCount}
          offTagsetIds={offTagsetIds}
          items={items}
          fieldNames={fieldNames}
          hasGloss={hasGloss}
          selectedId={selectedId}
          numbers={numbers}
          comments={comments}
          usageCounts={usageCounts}
          canManage={canManage}
          itemTo={itemTo}
          guardSelect={guardSelect}
          maxHeight={paneMaxH}
          onBulkAdd={() => dispatch({ type: 'dialog/open', kind: 'bulk' })}
          onReplace={() => dispatch({ type: 'dialog/open', kind: 'replace' })}
          onExport={handleExportTsv}
        />

        {/* ---- right pane: the entry, its concordance, its comments ---- */}
        <div className="min-w-0 flex-1">
          {!selectedId ? (
            <div className="flex min-h-[24rem] items-center justify-center rounded-lg border border-dashed bg-card/50">
              <p className="text-sm text-muted-foreground">
                Select an entry, or click “New” to add one.
              </p>
            </div>
          ) : isNew ? (
            entryEditor
          ) : (
            <Tabs value={pane} onValueChange={setPane}>
              <TabsList className="mb-3">
                <TabsTrigger value="entry" to={paneTo('entry')}>
                  Entry
                </TabsTrigger>
                <TabsTrigger value="concordance" to={paneTo('concordance')}>
                  Concordance
                  {conc.concPlan && (
                    <span className="rounded-full bg-muted px-1.5 text-[10px] leading-4 tabular-nums">
                      {conc.concPlan.totalHits.toLocaleString()}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="comments" to={paneTo('comments')}>
                  Comments
                  {(comments?.countFor(selectedId) ?? 0) > 0 && (
                    <span className="rounded-full bg-muted px-1.5 text-[10px] leading-4 tabular-nums">
                      {comments.countFor(selectedId)}
                    </span>
                  )}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="entry">
                <div className="flex flex-col gap-4">
                  {entryEditor}
                  {selectedItem && (
                    <>
                      <ExamplesPanel
                        item={selectedItem}
                        client={client}
                        linkedTokenIds={
                          conc.concPlan && !conc.concPlan.truncated ? conc.concPlan.hitIds : null
                        }
                        canManage={canManage}
                        onRemove={handleRemoveExample}
                      />
                      <ReferencedByPanel
                        item={selectedItem}
                        items={items}
                        fields={fields}
                        numbers={numbers}
                        itemTo={itemTo}
                      />
                    </>
                  )}
                </div>
              </TabsContent>

              <TabsContent value="concordance">
                <ConcordancePanel
                  conc={conc}
                  selectedItem={selectedItem}
                  canManage={canManage}
                  onAddExample={handleAddExample}
                />
              </TabsContent>

              <TabsContent value="comments">
                {selectedItem && comments && (
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
              </TabsContent>
            </Tabs>
          )}
        </div>

        {homographs.length > 1 && (
          <HomographDialog
            open={dialog?.kind === 'homograph'}
            onOpenChange={(o) => {
              if (!o) dispatch({ type: 'dialog/close' });
            }}
            group={homographs}
            currentId={tree.rootOf.get(selectedId)}
            onReorder={handleHomographOrder}
          />
        )}

        <BulkAddDialog
          open={dialog?.kind === 'bulk'}
          onOpenChange={(o) => {
            if (!o) dispatch({ type: 'dialog/close' });
          }}
          vocabularyId={vocabularyId}
          vocabularyName={vocabulary?.name}
          fields={fields}
          tagsetFor={tagsetFor}
          existingItems={items}
          client={client}
          onImported={handleImported}
        />

        <ReplaceDialog
          open={dialog?.kind === 'replace'}
          onOpenChange={(o) => {
            if (!o) dispatch({ type: 'dialog/close' });
          }}
          vocabularyName={vocabulary?.name}
          fields={fields}
          tagsetFor={tagsetFor}
          items={items}
          numbers={numbers}
          client={client}
          onApplied={handleImported}
        />

        <EntryDialogs
          dialog={dialog}
          dispatch={dispatch}
          selectedItem={selectedItem}
          draftForm={draft.form}
          usageCounts={usageCounts}
          deleteRefPatches={deleteRefPatches}
          deleteFreesSenses={deleteFreesSenses}
          onConfirmDelete={handleConfirmDelete}
          onDiscard={discardTo}
        />
      </div>
    </NavGuardProvider>
  );
};
