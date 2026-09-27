import {
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useCallback,
  useReducer,
} from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { createdId, isReviewed } from '@larc-iu/plaid-client';
import { useAuth } from '@/contexts/AuthContext';
import { canEditProject } from '@ui/domain/permissions.js';
import { AlertTriangle, History } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@ui/components/ui/tabs';
import { Button } from '@ui/components/ui/button';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { useTabParam } from '@/hooks/useTabParam';
import { notifyError, notifyWarning, isPermissionError } from '@/utils/feedback';
import { isUnknownOutcome } from '@ui/lib/errors.js';
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
  morphTypeOf,
} from '@/domain/vocabDictionary';
import { dropPrecedent } from '@/domain/precedentCache';
import { metadataPatchTo, metadataUpdates } from '@/domain/metadataPatch';
import { useSavingGuard } from '@ui/hooks/useSavingGuard.js';
import { useUnsavedDraft } from '@ui/hooks/useUnsavedDraft.js';
import {
  followIds,
  pendingId,
  recordSettled,
  settledId,
  stableKey,
} from '@ui/domain/pendingIds.js';
import { CHUNK } from '@/domain/bulk';
import { HomographDialog, ReferencedByPanel, ExamplesPanel } from './DictionaryPanels';
import { validateValue, changedValuesAllowed, entryTagsetFor } from '@/domain/tagsets';
import { useItemConcordance } from './useItemConcordance';
import { serializeVocabTsv } from '@/export/vocabTsv';
import { BulkAddDialog } from './BulkAddDialog';
import { ReplaceDialog } from './ReplaceDialog';
import { fieldText, fieldEmpty } from '@/domain/vocabItemFilter';
import { EntryComments } from './EntryComments';
import { useCommentStore } from '@ui/domain/useCommentStore';
import { anchorCaption } from '@/domain/commentAnchors';
import { downloadBlob, sanitizeFilename } from '@/export/files';
import {
  NEW_ID,
  cleanMeta,
  emptyFieldOf,
  initialState,
  isDirty,
  hasTyped,
  reducer,
  seedKeyFor,
} from './vocabItemsState';
import { useEntryList } from './useEntryList';
import { EntryList } from './EntryList';
import { soleProjectLinking } from '@/domain/vocabProject';
import { linksUmrProject, readRoleset, rolesetProblem } from '@/domain/vocabUmr';
import { EntryEditor } from './EntryEditor';
import { ConcordancePanel } from './ConcordancePanel';
import { EntryDialogs } from './EntryDialogs';
import { useAssistantAvailable } from '@ui/components/assistant/useAssistantAvailable.js';
import { useAskAssistant, useAssistantSubject } from '@ui/components/assistant/subject.js';
import { useWideEnoughToDock } from '@ui/components/assistant/useDock.js';
import { AssistantMark } from '@ui/components/assistant/PlaidMarks.jsx';
import { IGT_ASSISTANT } from '../projects/assistant/adapter.js';
import { Loading } from '@ui/components/shared/Loading.jsx';
import { readVocabulary } from '@/domain/vocabCache';
import { EntryRestoreDialog } from './EntryRestoreDialog';

// A past state read with no entry list: one empty list, so the memos over it
// keep their identity.
const NO_ENTRIES = Object.freeze([]);

// The Entries screen of a vocabulary. This component owns the data (the
// entries, their usage counts) and every write, sent through `writes`, the
// vocabulary's entry WriteQueue, which outlives this screen; the selection
// lives in the URL; the draft, the list's scope, and the open dialog live in
// one reducer (vocabItemsState.js); the list's order and paging in
// useEntryList; and the concordance in useItemConcordance. The panes are
// EntryList, EntryEditor, ConcordancePanel, and EntryDialogs.
export const VocabularyItems = ({
  vocabularyId,
  vocabulary,
  client,
  fields,
  writes,
  canManage: canManageNow = true,
  comments = null,
  canComment = false,
  past = null,
  historyPending = false,
  canRestore = false,
  onRestored = null,
  onOpenHistory = null,
}) => {
  // Re-render on comment changes, so the per-entry counts stay in step.
  useCommentStore(comments);
  // The assistant's records are keyed by the user whose store they live in.
  const { user } = useAuth();
  const [liveItems, setItems] = useState([]);
  // `past` is the vocabulary as the history rail shows it (`{ time,
  // vocabulary }`): its entries stand in for the live ones, and nothing can be
  // edited, only put back one entry at a time (EntryRestoreDialog). The
  // writes below all work on the live list, which stays loaded underneath.
  const pastTime = past?.time ?? null;
  const pastItems = past ? past.vocabulary?.items || NO_ENTRIES : null;
  const items = pastItems ?? liveItems;
  // Read-only from the click on a history entry, before its read lands.
  const canManage = canManageNow && !past && !historyPending;
  const [restoring, setRestoring] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [usageCountsNow, setUsageCounts] = useState(null); // {itemId: n} | null
  // Uses are counted now, which says nothing about a past state.
  const usageCounts = past ? null : usageCountsNow;
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
  const [pane, setPane, paneHref] = useTabParam(['entry', 'concordance', 'comments'], 'entry', {
    param: 'pane',
  });
  // The pane links keep the open entry, so a middle-click opens the same one.
  const { pathname } = useLocation();
  const paneTo = (name) => paneHref(pathname, name);
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
    // `loading` is in here because the pane is NOT in the tree on the first
    // commit: `measure` found a null ref, returned, and a []-dep effect never
    // runs again, so the measured height never applied and the pane fell back
    // to the guessed constant this exists to replace. Only a window resize
    // ever rescued it.
  }, [loading]);

  // The projects this user can read, one call per vocabulary, shared by the
  // lookups below, the usage counts and the concordance, which have no project
  // to look in when nothing links the vocabulary.
  const projectsRef = useRef(null);
  const readableProjects = () => {
    if (projectsRef.current?.key !== vocabularyId) {
      const promise = client.projects.list();
      // A failed read is asked again next time rather than remembered.
      promise.catch(() => {
        if (projectsRef.current?.promise === promise) projectsRef.current = null;
      });
      projectsRef.current = { key: vocabularyId, promise };
    }
    return projectsRef.current.promise;
  };
  // Whether a readable project links this vocabulary. The usage queries are
  // refused when none does. A failed read says yes, so the queries still run.
  const vocabLinked = () =>
    readableProjects().then(
      (projects) => projects.some((p) => (p?.vocabs || []).some((v) => v?.id === vocabularyId)),
      () => true,
    );

  // The open entry's concordance, loaded a batch at a time.
  const conc = useItemConcordance({
    client,
    vocabularyId,
    selectedId,
    skipId: NEW_ID,
    linked: vocabLinked,
  });

  // ---- derived from the entries ----
  const fieldNames = useMemo(() => fields.map((f) => f.name), [fields]);
  const hasGloss = useMemo(() => fields.some((f) => f.name === 'gloss'), [fields]);
  // The editorial status field, by whatever name this vocabulary declares it.
  const statusKey = useMemo(() => statusFieldKey(fields), [fields]);
  // How entries are told apart: the dotted number ("a 1.2"), used wherever an
  // entry is named.
  const numbers = useMemo(() => buildItemNumbers(items), [items]);

  const tree = useMemo(() => buildSenseTree(items), [items]);
  // The morph type each entry goes by: its own, else its headword's.
  const typeOf = useCallback((id) => morphTypeOf(tree, id), [tree]);
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
  // costs nothing, where the project needs a Validation tab and a query. Each
  // entry's values are read as its morph type gives (entryTagsetFor).
  const offTagsetIds = useMemo(() => {
    const out = new Set();
    if (!tagsetByField.size) return out;
    for (const it of items) {
      const read = entryTagsetFor(tagsetFor, typeOf(it.id), it.form);
      for (const name of tagsetByField.keys()) {
        if (validateValue(String(it.metadata?.[name] ?? ''), read(name)).length) {
          out.add(it.id);
          break;
        }
      }
    }
    return out;
  }, [items, typeOf, tagsetByField, tagsetFor]);
  // How many entries have nothing in the scoped field, and whether the
  // empty-only filter applies right now: it exists for a real field with
  // something to show, and is dropped by the reducer when the field changes.
  const emptyField = emptyFieldOf(scope.field);
  const emptyCount = useMemo(
    () => (emptyField ? items.filter((it) => fieldEmpty(it, emptyField)).length : 0),
    [items, emptyField],
  );
  useEffect(() => {
    if (!emptyField || emptyCount === 0) dispatch({ type: 'scope/clearEmptyOnly' });
  }, [emptyField, emptyCount]);
  const emptyOnly = scope.emptyOnly && !!emptyField && emptyCount > 0;

  // An entry made a moment ago is known by a pending id until the server
  // answers (see the writes below), and `?item=` can still hold it.
  const selectedItem = useMemo(() => {
    if (!selectedId || isNew) return null;
    const id = settledId(selectedId);
    return items.find((i) => i.id === id) || null;
  }, [items, selectedId, isNew]);
  // --- the assistant docked beside the entry list ---------------------------
  // The vocabulary is the standing scope, the way a document is on Analyze. An
  // entry reaches the chat only through Ask, as a chip that clears when sent.
  //
  // A vocabulary is its OWN resource at /vocabularies/:id, with no project in
  // scope, while the assistant is per project: the service registers on one,
  // discovery is per project, and a conversation's record is keyed by it. So
  // the project has to be resolved backwards, from the projects that link this
  // vocabulary. `projects.list()` carries each project's vocabs, so that is one
  // call. When exactly one project links it, that is the answer. When several
  // do the pane is not offered at all: filing the thread under a project the
  // user did not choose puts it in an Assistant tab they were never on.
  // The project itself, not just its id: the panel's write gate is a question
  // about the PROJECT (a writer there may edit the corpus the assistant plans
  // over) and not about who maintains this vocabulary.
  const [assistantProject, setAssistantProject] = useState(null);
  // Whether a project that links this vocabulary annotates UMR, which is
  // what puts the roleset band on an entry. Read from the same call: ANY
  // linking project counts, unlike the assistant above, because a roleset
  // belongs to the entry rather than to one project's thread.
  const [umrLinked, setUmrLinked] = useState(false);
  useEffect(() => {
    if (!client || !vocabularyId) return undefined;
    let alive = true;
    readableProjects()
      .then((projects) => {
        if (!alive) return;
        const id = soleProjectLinking(projects, vocabularyId);
        setAssistantProject(id ? (projects || []).find((p) => p.id === id) || null : null);
        setUmrLinked(linksUmrProject(projects, vocabularyId));
      })
      .catch(() => {
        // Discovery of the project failed, so the pane is simply not offered.
        if (alive) {
          setAssistantProject(null);
          setUmrLinked(false);
        }
      });
    return () => {
      alive = false;
    };
    // `readableProjects` is rebuilt every render and reads the vocabulary it
    // is keyed on, so these two are what the lookup depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, vocabularyId]);
  const assistantAvailable = useAssistantAvailable(client, assistantProject?.id, IGT_ASSISTANT.app);
  // Ask sets a focus and the SHELL opens the panel on it, so in a window with
  // no room for a panel the button did nothing at all when pressed.
  const wideEnoughForAssistant = useWideEnoughToDock();

  const askAssistant = useAskAssistant();
  const askAboutEntry = () => {
    if (!selectedItem) return;
    // The reference is the one `find_entry` accepts back: the form, with its
    // homograph number after a "#". The label is what the screen shows, which
    // writes the number out rather than subscripting it.
    //
    // Straight through the provider this screen is already under. The window
    // event is the island's escape hatch, for vanilla code that has no hook to
    // call, and it had no business in React.
    const n = numbers.get(selectedItem.id);
    askAssistant({
      ref: n ? `${selectedItem.form}#${n}` : selectedItem.form,
      label: itemLabel(selectedItem, numbers),
    });
  };

  // The open entry as it is now, beside the one a past state shows.
  const liveItem = useMemo(
    () => (selectedItem ? liveItems.find((i) => i.id === selectedItem.id) || null : null),
    [liveItems, selectedItem],
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
  //
  // A read waits for the entry writes still queued, and reads again when one
  // is made while it is on the wire, so the list never drops an edit the
  // server is still to get. `inTurn` is the refused write's own refetch, which
  // the queue is waiting on. It throws when it fails, so the queue tries it
  // again.
  const fetchItems = async ({ quiet = false, inTurn = false } = {}) => {
    try {
      if (!quiet) setLoading(true);
      if (!client) throw new Error('Not authenticated');
      if (!vocabularyId || vocabularyId === 'undefined' || vocabularyId === 'new') {
        throw new Error('Invalid vocabulary ID');
      }
      // The copy kept since the last read when the vocabulary has not changed
      // (vocabCache.js): a document opened just before read the same entries.
      const read = () => readVocabulary(client, vocabularyId);
      const vocabularyData = await (inTurn ? read() : writes.readWhenIdle(read));
      const fetched = vocabularyData.items || [];
      setItems(fetched);
      setError('');
      fetchUsageCounts(); // not awaited
      repairRefs(fetched); // not awaited
      return fetched;
    } catch (err) {
      if (inTurn) throw err;
      setError('Failed to load entries');
      console.error('Error fetching vocabulary items:', err);
      return null;
    } finally {
      if (!quiet) setLoading(false);
    }
  };

  // One grouped aggregate query: links per item AND per token-layer role
  // across every readable project. The role splits each entry's uses into
  // words and morphemes (an entry may be linked from both). The link is named
  // (`?l`), not left to the `vocab-link` shorthand: a link names a token once,
  // so with the link named the server can count without first removing
  // duplicate matches, which on a large lexicon took most of the query's time.
  const fetchUsageCounts = async () => {
    try {
      // A vocabulary no project links has no uses, and the query refuses it.
      if (!(await vocabLinked())) {
        setUsageCounts(null);
        setUsageKinds(null);
        return;
      }
      const res = await client.query({
        where: [
          ['vocab', '?v', { layer: vocabularyId }],
          ['link', '?l', { item: '?v' }],
          ['link-token', '?l', '?t'],
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
  // Write entries' metadata. The plans are whole maps and the write is each
  // one's patch against what that entry carried when the plan was made, so a
  // key nobody here changed (one another tab or a service wrote meanwhile) is
  // left alone. One request is one transaction holding the vocabulary's write
  // lock, hence the chunks. `metaById` is what the entries hold at the time of
  // the call, which is not always the list in state: the load-time repair runs
  // against what it has just fetched. Ids the server has answered for since
  // go out as the server's.
  const bulkRepoint = async (patches, metaById) => {
    const updates = metadataUpdates(patches, metaById).map(({ id, metadata }) => ({
      id: settledId(id),
      metadata: followIds(metadata),
    }));
    for (let i = 0; i < updates.length; i += CHUNK) {
      await client.vocabItems.bulkUpdate(updates.slice(i, i + CHUNK));
    }
  };
  const metadataNow = (list) => new Map((list || []).map((it) => [it.id, it.metadata]));
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

  // Every write here shows first and is sent in its turn in `writes`, so two
  // quick drags reach the server in the order they were made. An entry made
  // here is in the list under a pending id until the server answers, and
  // `settleEntries` swaps the server's in, in the list, in any reference to
  // it, and in `?item=`. A refused write says so and fetches the list again,
  // which puts back what the screen showed. The writes queued behind it are
  // still sent, and the list is fetched again once they have landed. Resolves
  // to whether the write landed.
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  // The pending id a create has sent the URL to, until a render shows it
  // there: a refusal can arrive first.
  const creatingRef = useRef(null);
  if (creatingRef.current === selectedId) creatingRef.current = null;
  const settleEntries = (ids) => {
    const known = new Map([...ids].filter(([, server]) => server));
    if (!known.size) return;
    recordSettled(known);
    setItems((prev) => followIds(prev));
    const open = selectedIdRef.current;
    if (open && known.has(open)) goItem(known.get(open), { replace: true });
  };
  // Closing the tab asks first while a write is still on its way, and keeps
  // asking after this screen is left, since the writes go on without it.
  useSavingGuard(writes);
  // A refusal's refetch re-seeds the open draft from what the server holds, unless
  // something is typed into it: the entry open now need not be the one the
  // refused write was about, and what is typed there is not the server's to
  // take back. `refused` replaces that step for a write with its own way back.
  const unseedUnlessTyped = () => {
    if (!typedRef.current) dispatch({ type: 'draft/unseed' });
  };
  const resync = () => fetchItems({ quiet: true, inTurn: true });
  // A save says nothing when it lands, the way every screen that shows an
  // edit at once does. A refusal is toasted. `resync` stands in for the
  // entries' refetch, for a save that needs to see what it brought back.
  const sendInTurn = (label, write, failure, { refused, resync: reread = resync } = {}) =>
    writes.push(() => client.withOperation(label, write), {
      refused: (err) => {
        console.error(`${label}:`, err);
        notifyError(err, failure);
        (refused || unseedUnlessTyped)(err);
      },
      resync: reread,
    });

  // Bulk Add and Replace: a run of writes planned against the entries as
  // shown, which can hold a save still on its way. The run takes its turn
  // behind that save. Resolves `{ landed, error }`. A refusal re-reads the
  // entries here, the dialog reports it.
  const sendPlanned = async (label, write) => {
    let error = null;
    const landed = await writes.push(() => client.withOperation(label, write), {
      refused: (err) => {
        error = err;
        unseedUnlessTyped();
      },
      resync,
    });
    return { landed, error };
  };

  // The draft as of the latest render, for the async writes below that finish
  // a round trip later and need to know what the form was filled from.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // A refused new entry's draft, held until the form it goes back to opens.
  const refusedNewRef = useRef(null);

  // A reference that points at an entry no longer here (deleted through the
  // API, or by another app) is cleared on the first load by someone who can
  // write, under one operation. Once per mount: after a repair there is
  // nothing left to repair.
  const repairedRef = useRef(false);
  const repairRefs = (fetched) => {
    if (!canManage || repairedRef.current) return;
    repairedRef.current = true;
    const { patches, findings } = validateVocabRefs(fetched, fields);
    if (!patches.length) return;
    const before = metadataNow(fetched);
    // An entry the repair touches is re-seeded from the repaired metadata.
    // Left alone the form still holds the cleared value and a Save writes it
    // back.
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
    // A vocabulary that has lost a pile of entries has as many writes as it
    // has references to them, so they go out in bulk.
    sendInTurn(
      'Repair entry references',
      () => bulkRepoint(patches, before),
      'Failed to repair entry references',
    );
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
    // Keyed on the id the entry was first shown under, so a new entry's draft
    // is not filled again, over what is being typed, when its server id
    // replaces the pending one in the URL.
    // A past state is its own seed, so moving to it or back to now fills the
    // form from what is shown.
    const seedKey = seedKeyFor(stableKey(selectedId), newParent) + (pastTime ? `@${pastTime}` : '');
    if (draft.seedKey === seedKey) return;
    if (selectedId === NEW_ID && refusedNewRef.current?.seedKey === seedKey) {
      // A new entry the server refused, back in the form as it was typed.
      const back = refusedNewRef.current;
      refusedNewRef.current = null;
      dispatch({ type: 'draft/seed', seedKey, form: back.seedForm, fields: {} });
      dispatch({ type: 'draft/form', form: back.form });
      dispatch({ type: 'draft/fields', fields: back.fields });
      return;
    }
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
  }, [selectedId, newParent, items, tree, draft.seedKey, pastTime]);

  const dirty = isNew ? isDirty(draft, null) : selectedItem ? isDirty(draft, selectedItem) : false;
  // What leaving would lose. A new sense still holding only its headword's
  // form can be saved, but leaving it loses nothing.
  const typed = isNew ? hasTyped(draft, null) : dirty;
  // The draft's fields read as the morph type it has now: its own, else its
  // headword's (morphTypeOf), as the list above reads a saved entry.
  const draftTagsetFor = entryTagsetFor(
    tagsetFor,
    draft.fields?.morphType ||
      morphTypeOf(tree, isNew ? liveNewParent : (tree.parentOf.get(selectedId) ?? null)),
    draft.form,
  );
  // Only a CHANGED value is held to its tagset, so an off-tagset value an
  // import left behind does not lock the entry (see changedValuesAllowed).
  const tagsetsAllow = changedValuesAllowed(
    fields,
    draft.fields,
    (f) => draftTagsetFor(f.name),
    isNew ? {} : editableMetadata(selectedItem?.metadata),
  );
  // The roleset likewise: one an older entry or an import left behind does not
  // lock the entry, least of all where the band that could mend it is hidden.
  const draftRoleset = readRoleset(draft.fields);
  const rolesetRefused =
    draftRoleset !== (isNew ? '' : readRoleset(editableMetadata(selectedItem?.metadata)))
      ? rolesetProblem(draftRoleset)
      : null;
  const saveAllowed = tagsetsAllow && !rolesetRefused;

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

  // Leaving an entry with unsaved edits asks first, whichever way out: a row,
  // a link in a panel, the vocabulary's tabs, the shell, Back, or a closed tab.
  useUnsavedDraft(typed ? 'The entry you have typed' : null);
  const typedRef = useRef(typed);
  typedRef.current = typed;

  // A bulk import can fill in the very item the detail editor has open, which
  // would leave its draft showing pre-import values (and looking dirty against
  // the refreshed item). Re-seed the draft from what came back, unless the
  // user really does have unsaved edits, which stay theirs. The read waits for
  // the entry writes still queued (see fetchItems).
  const handleImported = async () => {
    const refreshed = await fetchItems({ quiet: true });
    if (!refreshed || typedRef.current) return;
    dispatch({ type: 'draft/unseed' });
    const openId = settledId(selectedIdRef.current);
    if (!openId || openId === NEW_ID) return;
    if (!refreshed.some((i) => i.id === openId)) goItem(null, { replace: true });
  };

  // What the shell's assistant panel is about while this screen is open: the
  // vocabulary, standing, the way a document is on the Analyze tab. An entry
  // reaches the chat only through Ask.
  useAssistantSubject({
    projectId: assistantProject?.id,
    projectName: assistantProject?.name,
    kind: 'lexicon',
    id: vocabularyId,
    name: vocabulary?.name,
    canWrite: canEditProject(assistantProject, user),
    contributor:
      !!assistantProject &&
      !!user &&
      isReviewed(assistantProject, user.id, { isAdmin: !!user.isAdmin }),
    onApplied: handleImported,
    // What `@` offers in the composer: this vocabulary's entries, by the
    // reference `find_entry` takes (the form, and its homograph number after a
    // "#"). The label writes the number out, the way the screen does. This is
    // the case the gesture exists for: two entries spelled alike are told
    // apart by a number a reader has no way to know they need.
    mentions: () => {
      const entries = items.map((item) => ({
        value: numbers.get(item.id) ? `${item.form}#${numbers.get(item.id)}` : item.form,
        label: itemLabel(item, numbers),
        hint: item.metadata?.gloss || '',
      }));
      return entries.length ? [{ group: 'Entries', items: entries }] : [];
    },
  });

  const handleSave = async () => {
    if (!draft.form.trim()) {
      notifyError('The form cannot be empty', 'Invalid Form');
      return;
    }
    if (rolesetRefused) {
      notifyError(rolesetRefused, 'Not saved');
      return;
    }
    if (!saveAllowed) {
      notifyError('A field holds a value its tagset does not accept.', 'Not saved');
      return;
    }
    // The structure the form does not edit (sense place, examples, import
    // identity) is carried over from the entry as it is NOW, so a renumber
    // or an example added while the form was open is not written back over
    // by this save.
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
      const withPlace = liveNewParent ? withParentSet(tree, { metadata }, liveNewParent) : metadata;
      const id = pendingId();
      const parent = liveNewParent;
      const parentForm = parent ? (tree.byId.get(parent)?.form ?? '') : '';
      setItems((prev) => [...prev, saved(id, withPlace)]);
      // Replace: the `?item=new` step becomes the entry it created, so Back
      // does not return to an empty form for an entry that now exists.
      creatingRef.current = id;
      goItem(id, { replace: true });
      dispatch({ type: 'draft/form', form });
      // Back to the new-entry form holding what is typed there, so Create
      // sends it again.
      const backToNew = ({ form: typedForm, fields: typedFields }) => {
        refusedNewRef.current = {
          seedKey: seedKeyFor(NEW_ID, parent),
          seedForm: parentForm,
          form: typedForm,
          fields: typedFields,
        };
        goItem(NEW_ID, { replace: true }, parent);
      };
      // A create whose answer was lost may have made the entry. The entries
      // are read again first, and Create is offered again only when the
      // entry is not among them, so pressing it cannot make a second one.
      const alreadyThere = new Set(items.map((i) => i.id));
      let reread = null;
      let unsure = null;
      sendInTurn(
        `Add entry "${form}"`,
        async () => {
          const meta = followIds(withPlace);
          const created = await client.vocabItems.create(
            vocabularyId,
            form,
            Object.keys(meta).length ? meta : undefined,
          );
          settleEntries(new Map([[id, createdId(created)]]));
        },
        'Failed to save the entry',
        {
          // The pending id names nothing now. Still open, it goes back to the
          // new-entry form.
          refused: (err) => {
            const stillOpen = selectedIdRef.current === id || creatingRef.current === id;
            if (creatingRef.current === id) creatingRef.current = null;
            if (!stillOpen) {
              unseedUnlessTyped();
              return;
            }
            if (isUnknownOutcome(err)) unsure = draftRef.current;
            else backToNew(draftRef.current);
          },
          resync: async () => {
            reread = await fetchItems({ quiet: true, inTurn: true });
          },
        },
      ).then(() => {
        // Only while nothing else has been opened since.
        const here = selectedIdRef.current;
        if (!unsure || (here !== id && here !== NEW_ID)) return;
        const made = (reread || []).find((i) => i.form === form && !alreadyThere.has(i.id));
        if (made) goItem(made.id, { replace: true });
        else backToNew(unsure);
      });
      return;
    }
    const item = selectedItem;
    setItems((prev) => prev.map((i) => (i.id === item.id ? saved(item.id) : i)));
    dispatch({ type: 'draft/form', form });
    // Only the keys the save changes are sent, so one written elsewhere
    // since this entry was loaded stays.
    const ops = metadataPatchTo(item.metadata, metadata);
    sendInTurn(
      `Edit entry "${form}"`,
      async () => {
        const update = {
          id: settledId(item.id),
          ...(form !== item.form ? { form } : {}),
          ...(ops.length ? { metadata: followIds(ops) } : {}),
        };
        if (Object.keys(update).length > 1) await client.vocabItems.bulkUpdate([update]);
      },
      'Failed to save the entry',
    );
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
    const deletedId = selectedItem.id;
    // A headword with many senses, or a root with many variants, is one
    // repoint per referring entry: the same walk the load-time repair does,
    // so the same bulk write.
    const patches = deleteRefPatches;
    const before = metadataNow(items);
    dispatch({ type: 'dialog/close' });
    goItem(null, { replace: true });
    if (patches.length) foldPatches(patches);
    setItems((prev) => prev.filter((i) => i.id !== deletedId));
    sendInTurn(
      `Delete entry "${selectedItem.form}"`,
      async () => {
        if (patches.length) await bulkRepoint(patches, before);
        try {
          await client.vocabItems.delete(settledId(deletedId));
        } finally {
          // Its links go with it, in documents no editor has open.
          dropPrecedent();
        }
      },
      'Failed to delete the entry',
    );
  };

  // ---- dictionary: placing senses, examples ----
  // Each of these writes the entry's stored metadata, not the draft: the
  // draft is re-seeded from the result unless the user has unsaved edits,
  // which stay theirs.
  const commitPatches = (patches, label, failure) => {
    const before = metadataNow(items);
    foldPatches(patches);
    return sendInTurn(label, () => bulkRepoint(patches, before), failure);
  };
  const commitMetadata = (id, metadata, label, failure) =>
    commitPatches([{ id, metadata }], label, failure);
  // Make `id` a sense of `parentId` (last), or, with null, its own entry.
  const handleMoveUnder = async (id, parentId) => {
    const moving = tree.byId.get(id);
    if (!moving) return;
    commitMetadata(
      id,
      withParentSet(tree, moving, parentId),
      parentId
        ? `Make "${moving.form}" a sense of "${tree.byId.get(parentId)?.form ?? ''}"`
        : `Make "${moving.form}" its own entry`,
      'Failed to move the entry',
    );
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
    const above = tree.parentOf.get(id);
    const place = above
      ? { parent: above, senseOrder: it.metadata?.senseOrder ?? nextSenseOrder(tree, above) }
      : {};
    // What belongs to the ENTRY goes up with the new headword: its place
    // among the entries spelled alike, the FLEx entry it came from, and every
    // headword-only field. Left below, they would sit on a sense, where the
    // form does not even show them. The morph type and lexeme form go to
    // both: the interlinear line reads the morph type off the item a token is
    // linked to, which stays the sense.
    const { entry, sense } = splitEntryLevel(it.metadata, fields);
    const headMeta = { ...entry, ...place };
    const headId = pendingId();
    const senseMeta = { ...sense, parent: headId, senseOrder: 1 };
    setItems((prev) => [
      ...prev,
      {
        id: headId,
        layer: vocabularyId,
        form: it.form,
        ...(Object.keys(headMeta).length ? { metadata: headMeta } : {}),
      },
    ]);
    foldPatches([{ id, metadata: senseMeta }]);
    // The split moved the headword-only fields off this item, so the open
    // draft is re-seeded from it. Left alone it reads dirty without an edit,
    // and a Save would put those fields back on the sense.
    dispatch({ type: 'draft/unseed' });
    sendInTurn(
      `Add a headword over "${it.form}"`,
      async () => {
        const meta = followIds(headMeta);
        const created = await client.vocabItems.create(
          vocabularyId,
          it.form,
          Object.keys(meta).length ? meta : undefined,
        );
        settleEntries(new Map([[headId, createdId(created)]]));
        await bulkRepoint([{ id, metadata: senseMeta }], new Map([[id, it.metadata]]));
      },
      'Failed to add the headword',
    );
  };
  // A drop in the sense tree: before or after a sense, into one, or out.
  const handleSenseDrop = async (id, target) => {
    const patches = planSenseDrop(tree, id, target);
    if (!patches.length) return;
    const moving = tree.byId.get(id);
    commitPatches(patches, `Move "${moving?.form ?? ''}"`, 'Failed to move the sense');
  };
  // The entries spelled like the open one, reordered by dragging in the
  // homograph dialog: their numbers are written 1..n under one operation.
  const handleHomographOrder = async (orderedIds) => {
    const patches = planHomographOrder(homographs, orderedIds);
    if (!patches.length) return;
    commitPatches(
      patches,
      `Reorder the entries spelled "${homographs[0]?.form ?? ''}"`,
      'Failed to reorder the entries',
    );
  };
  const handleAddExample = async (docId, tokenId) => {
    if (!selectedItem) return;
    const next = withExampleAdded(selectedItem.metadata, { document: docId, token: tokenId });
    if (next === selectedItem.metadata) return;
    commitMetadata(
      selectedItem.id,
      next,
      `Add an example to "${selectedItem.form}"`,
      'Failed to add the example',
    );
  };
  const handleRemoveExample = async (index) => {
    if (!selectedItem) return;
    commitMetadata(
      selectedItem.id,
      withExampleRemoved(selectedItem.metadata, index),
      `Remove an example from "${selectedItem.form}"`,
      'Failed to remove the example',
    );
  };

  // After a restore, or its undo: back to the vocabulary as it is now, read
  // again. An entry's form or links changing moves what the Analyze tab would
  // propose for a word, so its remembered proposals go too.
  const afterRestore = async () => {
    dropPrecedent();
    await onRestored?.();
    await fetchItems({ quiet: true });
    // The form was filled from the entry as it read before the restore (the
    // list is read again only after the view leaves the past state), so it is
    // filled again from what was just read, or a Save would write the old
    // values back.
    if (!typedRef.current) dispatch({ type: 'draft/unseed' });
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
      tagsetFor={draftTagsetFor}
      statusKey={statusKey}
      formGroups={formGroups}
      umrLinked={umrLinked}
      homographs={homographs}
      usageCounts={usageCounts}
      usageKinds={past ? null : usageKinds}
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
    return <Loading label="Loading entries…" className="py-6 text-center" />;
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
            {/* Ask shares the tab strip's row rather than taking one of its
                  own. In its own row it floated in the right margin with
                  nothing around it, and because it comes and goes with the
                  selection it moved the tabs down whenever an entry was
                  chosen. Here the row's height is the strip's, so nothing
                  reflows either way. Just "Ask": the entry it is about is the
                  heading directly below, so naming it in the label repeated a
                  fact from a centimetre away. */}
            <div className="mb-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
              <TabsList>
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
              <div className="flex shrink-0 items-center gap-2">
                {past && selectedItem && !liveItem && (
                  <span className="text-xs text-muted-foreground">Deleted since</span>
                )}
                {past && selectedItem && canRestore && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setRestoring(true)}
                  >
                    Restore
                  </Button>
                )}
                {!past && selectedItem && onOpenHistory && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="gap-1.5"
                    onClick={onOpenHistory}
                  >
                    <History className="h-3.5 w-3.5" /> History
                  </Button>
                )}
                {!past && assistantAvailable && wideEnoughForAssistant && selectedItem && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0 gap-1.5"
                    onClick={askAboutEntry}
                    title="Ask the assistant about this entry"
                  >
                    <AssistantMark className="h-3.5 w-3.5" />
                    Ask
                  </Button>
                )}
              </div>
            </div>

            <TabsContent value="entry">
              <div className="flex flex-col gap-4">
                {entryEditor}
                {selectedItem && (
                  <>
                    <ExamplesPanel
                      item={selectedItem}
                      client={client}
                      linkedTokenIds={
                        conc.concPlan && !conc.concPlan.hitIdsCapped ? conc.concPlan.hitIds : null
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
        send={sendPlanned}
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
        morphTypeOf={typeOf}
        items={items}
        numbers={numbers}
        client={client}
        send={sendPlanned}
        onApplied={handleImported}
      />

      {past && selectedItem && (
        <EntryRestoreDialog
          open={restoring}
          onOpenChange={setRestoring}
          client={client}
          vocabularyId={vocabularyId}
          asOf={pastTime}
          past={selectedItem}
          live={liveItem}
          label={itemLabel(selectedItem, numbers)}
          fields={fields}
          onRestored={afterRestore}
        />
      )}

      <EntryDialogs
        dialog={dialog}
        dispatch={dispatch}
        selectedItem={selectedItem}
        usageCounts={usageCounts}
        deleteRefPatches={deleteRefPatches}
        deleteFreesSenses={deleteFreesSenses}
        onConfirmDelete={handleConfirmDelete}
      />
    </div>
  );
};
