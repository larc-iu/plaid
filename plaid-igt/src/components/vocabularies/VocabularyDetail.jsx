import { useState, useEffect, useMemo, useRef } from 'react';
import { Link, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  BookText,
  Settings,
  Trash2,
  Plus,
  AlertTriangle,
  MessageSquare,
  History,
  Info,
} from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Input } from '@ui/components/ui/input';
import { Label } from '@ui/components/ui/label';
import { Switch } from '@ui/components/ui/switch';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@ui/components/ui/tabs';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@ui/components/ui/select';
import {
  readVocabFields,
  IGT_NAMESPACE,
  vocabImporting,
  markProjectState,
  unmarkVocab,
} from '@/domain/igtConfig';
import { entryMorphTypesOf } from '@/domain/vocabLookup';
import { planKeptTypes, queueKeptTypes, busyLinkedDocument } from '@/domain/keptMorphType';
import { refusalSaid, statusOf } from '@ui/lib/errors.js';
import { countOf, plural } from '@ui/lib/plural.js';
import {
  normalizeVocabFields,
  newVocabField,
  seedDefaultFields,
  fieldsToConfig,
  fieldLabel,
  isBuiltInField,
  vocabGovernedFields,
  isReservedFieldName,
  FIELD_TYPES,
  FIELD_SCOPES,
  ENTRY_ROLES,
} from '@/domain/vocabFields';
import { ENTRY_ROLE_CHOICES, proposeEntryRole } from '@/domain/entryRole';
import {
  buildSenseTree,
  morphTypeOf,
  refIds,
  statusTagset,
  statusFieldSeed,
  statusTagsetName,
  statusFieldKey,
  dropsReservedStatus,
  reservedStatusMessage,
  RESERVED_STATUS_VALUES,
  STATUS_TAGSET,
} from '@/domain/vocabDictionary';
import { keyedSend } from '@ui/domain/keyedSend.js';
import { sendFieldPrune } from './vocabSends.js';
import { readTagsets, byTagsetName, glossReadingOf } from '@/domain/tagsets';
import { TagsetsManager } from '@/components/projects/settings/TagsetsManager.jsx';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
} from '@ui/components/ui/dialog';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { storedConfig } from '@ui/domain/configCells.js';
import {
  queueLexiconFieldsSave,
  queueLexiconTagsetsSave,
  tagsetsChangedError,
} from '@/domain/tagsetsSave';
import { useConfigCell } from '@ui/hooks/useConfigCell.js';
import { VocabularyItems } from './VocabularyItems';
import { VocabularyBorrowers } from './VocabularyBorrowers';
import { VocabularyCommentsTab } from './VocabularyCommentsTab';
import { CommentStore } from '@ui/domain/CommentStore';
import { useCommentStore } from '@ui/domain/useCommentStore';
import {
  canEditProject,
  canManageProject,
  canManageVocabulary,
  canEditVocabularyEntries,
  canMoveVocabulary,
  vocabularyRole,
} from '@ui/domain/permissions.js';
import { isolate } from '@ui/lib/bidi.js';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { useSavingGuard } from '@ui/hooks/useSavingGuard.js';
import { useUnsavedDraft, useUnsavedGuard } from '@ui/hooks/useUnsavedDraft.js';
import { queuesStatus, vocabWriteQueue } from './vocabWriteQueue.js';
import { SaveStatus } from '@ui/components/shared/SaveStatus.jsx';
import { createOnce } from '@ui/lib/createOnce.js';
import { useTabParam } from '@ui/hooks/useTabParam.js';
import { Loading } from '@ui/components/shared/Loading.jsx';
import { RowControls } from '@/components/shared/RowControls';
import { sameNameIgnoringCase } from '@/domain/nameMatch';
import { Notice } from '@ui/components/shared/Notice.jsx';
import { Breadcrumb } from '@ui/components/shared/Breadcrumb.jsx';
import { DELETE_BUTTON_CLASS } from '@ui/lib/destructive.js';
import { HistoryDrawer, HISTORY_DRAWER_WIDTH } from '@ui/components/shared/HistoryDrawer.jsx';
import { fullTimestamp } from '@ui/lib/formatTime.js';
import { sameName } from '@ui/lib/nameKey.js';
import { useVocabHistory } from './useVocabHistory';
import { VocabHistoryChanges } from './VocabHistoryChanges.jsx';
import { useHistoryParam } from '@ui/hooks/useHistoryParam.js';
import { SegmentedControl } from '@ui/components/shared/SegmentedControl.jsx';
import { TYPE } from '@ui/lib/typeScale.js';
import { cn } from '@ui/lib/utils';

// A tab the past state does not reach. The trigger is an anchor, which the
// `disabled:` variant does not match, so it keys on Radix's data attribute.
const PAST_DISABLED = 'data-[disabled]:pointer-events-none data-[disabled]:opacity-50';

// Radix Select has no empty-string item value, so "no tagset" needs a sentinel.
const NO_TAGSET = '__none__';
// And "no role".
const NO_ROLE = '__none__';

// What a field holds, as the Type picker offers it: text, one entry, or a
// list of entries. `many` only means anything with the item type, so the two
// travel as one choice.
const TYPE_CHOICES = [
  { key: 'text', label: 'Text', type: FIELD_TYPES.TEXT, many: false },
  { key: 'item', label: 'Entry', type: FIELD_TYPES.ITEM, many: false },
  { key: 'items', label: 'Entries', type: FIELD_TYPES.ITEM, many: true },
];
const typeChoiceOf = (field) =>
  field.type === FIELD_TYPES.ITEM ? (field.many ? 'items' : 'item') : 'text';
const typeLabelOf = (field) => TYPE_CHOICES.find((c) => c.key === typeChoiceOf(field)).label;
const SCOPE_LABELS = { [FIELD_SCOPES.SENSE]: 'Every sense', [FIELD_SCOPES.ENTRY]: 'Headword only' };

// Core refuses to delete a vocabulary while another project uses it (409),
// for everyone, and counts them as `other-projects`, naming none. The count,
// or null for any other failure.
const otherProjectsOf = (err) =>
  statusOf(err) === 409 ? Number(err?.responseData?.['other-projects']) || null : null;
const otherProjectsSaid = (n) =>
  `${countOf(n, 'other project')} ${n === 1 ? 'uses' : 'use'} this vocabulary.`;

// A name inside a line built as a string (a confirm's title or body).
const quoted = (name) => `“${isolate(name)}”`;

// The line the Entries screen shows a person who reads the vocabulary and may
// not change its entries. `role` is their role in its project
// (`vocabularyRole`), `homeName` that project's name, or null when they cannot
// read it. Null for a writer or maintainer, who edit. Only a role in the
// project lets someone read its name, so anyone else is told it belongs to
// another project.
const entriesReadOnlyNote = (role, homeName) => {
  if (role === 'maintainer' || role === 'writer') return null;
  if (role === 'reader' && homeName)
    return (
      <>
        Read only: you have reader access to “<span dir="auto">{homeName}</span>”.
      </>
    );
  return 'Read only: this vocabulary belongs to another project.';
};

export const VocabularyDetail = () => {
  const { vocabularyId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  // The layer a failed creation already made, so pressing Create again
  // finishes it instead of leaving an unreachable second one behind.
  const createdRef = useRef(null);
  const mintRef = useRef(null);
  // A save in flight, so a second click cannot start another one.
  const [saving, setSaving] = useState(false);
  const confirm = useConfirm();
  const { user, client, logout } = useAuth();
  const isNewVocabulary = !vocabularyId;

  const [vocabulary, setVocabulary] = useState(null);
  // New vocab: a fixed label; existing: the loaded name (null while loading).
  useDocumentTitle(isNewVocabulary ? 'New vocabulary' : vocabulary?.name);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [editedName, setEditedName] = useState('');
  // The project a new vocabulary is made in, its home. Preselected from
  // `?project=` (a project's Settings link here).
  const [newProjectId, setNewProjectId] = useState(() => searchParams.get('project') || '');
  // The id a new vocabulary's create names is kept across presses of Create
  // for one name in one project only (createOnce.js). A vocabulary a failed
  // attempt made in another project is not finished in this one.
  useEffect(() => {
    mintRef.current = null;
  }, [editedName, newProjectId]);
  useEffect(() => {
    createdRef.current = null;
  }, [newProjectId]);

  // The vocabulary's home project as this person reads it, with its role
  // lists, or null when they cannot read it (403): rights are its roles.
  // Kept with the id it was read for, so a vocabulary whose project moved
  // has no home until that one is read.
  const [homeState, setHomeState] = useState(null);
  const home =
    vocabulary?.project && homeState?.id === vocabulary.project ? homeState.project : null;
  const homeIdRef = useRef(null);
  homeIdRef.current = homeState?.id ?? null;
  const readHome = async (projectId) => {
    if (!projectId) return null;
    try {
      return await client.projects.get(projectId);
    } catch (err) {
      if (statusOf(err) === 401) throw err;
      if (statusOf(err) !== 403) console.error('Error reading the vocabulary’s project:', err);
      return null;
    }
  };
  // The projects this person can read, with their role lists: the comment
  // gate, the New vocabulary project list and the Move list. Null until read.
  const [projects, setProjects] = useState(null);
  const readProjects = (alive = () => true) =>
    client.projects
      .list()
      .then((list) => {
        if (alive()) setProjects(list || []);
      })
      .catch((err) => {
        console.error('Error reading the projects:', err);
        if (alive()) setProjects([]);
      });
  useEffect(() => {
    if (!client || !user) return undefined;
    let alive = true;
    readProjects(() => alive);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, user]);
  const role = vocabularyRole(vocabulary, home, user);
  const canManage = canManageVocabulary(vocabulary, home, user);
  const canEditEntries = canEditVocabularyEntries(vocabulary, home, user);
  // A mark naming a project that is gone (a Delete that could not take it
  // off) reads as no mark (`withLiveMarks`), so the vocabulary opens as an
  // ordinary one. A read only: opening writes nothing (REV-FX-R57-3-1, R3).
  // Core says 'gone' to an admin only: anyone else reads a deleted project as
  // 'unreadable', and the vocabulary's maintainer may take the mark off by
  // hand (CR-IGT-1, ruling Q4).
  const [markState, setMarkState] = useState(null);
  const staleMark = markState === 'gone';
  const markedFor = vocabImporting(vocabulary?.config)
    ? (vocabulary.config[IGT_NAMESPACE].import?.projectId ?? null)
    : null;
  useEffect(() => {
    setMarkState(null);
    if (!markedFor) return undefined;
    let alive = true;
    markProjectState(client, markedFor).then((state) => {
      if (alive) setMarkState(state);
    });
    return () => {
      alive = false;
    };
  }, [client, markedFor]);
  // Optimistic: the page opens at once, and the mark comes back if the
  // write is refused.
  const detachFromImport = async () => {
    const before = vocabulary;
    const { import: _, ...igt } = before.config[IGT_NAMESPACE];
    setVocabulary({ ...before, config: { ...before.config, [IGT_NAMESPACE]: igt } });
    if (!(await unmarkVocab(client, before.id))) {
      setVocabulary((v) => (v?.id === before.id ? before : v));
      notifyError('Could not detach the vocabulary from the import.');
    }
  };
  // Normalized field inventory: [{name, inline, immutable}], morphType always present.
  const [fields, setFields] = useState([]);
  const [newFieldName, setNewFieldName] = useState('');
  // The vocabulary's own tagsets (config.igt.tagsets, the project's shape).
  // Held here between a save and the refetch so the editor does not flicker
  // back to the pre-save list in between.
  const [draftTagsets, setDraftTagsets] = useState(null);
  const tagsets = draftTagsets ?? readTagsets(vocabulary?.config);
  const tagsetNames = Object.keys(tagsets);
  // The field holding the Status role. Every vocabulary has one (Luke,
  // 2026-11-12): it cannot be removed, its role cannot be changed, and no
  // other field takes the role while it holds it. A job marks the entries it
  // makes there.
  const statusKey = statusFieldKey(fields);
  const roleChoices = statusKey
    ? ENTRY_ROLE_CHOICES.filter((c) => c.role !== ENTRY_ROLES.STATUS)
    : ENTRY_ROLE_CHOICES;
  // Which fields point at which tagset: the delete warning, the rename
  // repoint and the seed all read this.
  const tagsetUsage = useMemo(
    () => byTagsetName(vocabGovernedFields(fields, vocabulary?.config)),
    [fields, vocabulary],
  );
  const [deleteModalOpened, setDeleteModalOpened] = useState(false);
  // What the delete would do, asked of core when the question opens (its read
  // of a delete, never the delete): `{ links }`, the links in its project's documents that go with it,
  // or `{ otherProjects }` while other projects use it, which core refuses the
  // delete for. Undefined while asked, null when it could not be read.
  const [deleteCheck, setDeleteCheck] = useState(undefined);
  const openDeleteModal = () => {
    setDeleteCheck(undefined);
    setDeleteModalOpened(true);
    Promise.resolve()
      .then(() => client.vocabLayers.deletion(vocabularyId))
      .then((r) => setDeleteCheck({ links: r?.links ?? 0 }))
      .catch((err) => {
        const n = otherProjectsOf(err);
        setDeleteCheck(n ? { otherProjects: n } : null);
      });
  };
  const closeDeleteModal = () => setDeleteModalOpened(false);
  const [confirmDeleteName, setConfirmDeleteName] = useState('');

  // Walking from vocabulary A to vocabulary B keeps this component mounted and
  // starts a second load without ending the first. Nothing orders them, so A
  // can answer last and the Settings tab would then hold A's field inventory
  // and A's tagsets under B's name, one Save away from writing them onto B.
  // One token per vocabulary id, cancelled by the effect's cleanup, and every
  // writer of `vocabulary` checks it.
  const live = useRef(null);

  // Two write queues per vocabulary (see WriteQueue.js): its schema and name,
  // and its entries. They outlive the tab that made the writes, so a read
  // from another tab waits for them, and closing the browser tab asks while
  // either is still sending.
  const writes = useMemo(
    () => ({ schema: vocabWriteQueue(), entries: vocabWriteQueue() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vocabularyId],
  );
  useSavingGuard(writes.schema);
  useSavingGuard(writes.entries);
  // One pill for both queues: an entry or a setting being sent again until
  // the server answers.
  const saveStatus = useMemo(
    () => queuesStatus(writes.schema, writes.entries),
    [writes.schema, writes.entries],
  );
  const guardLeavingTab = useUnsavedGuard();
  // A name typed and not yet saved, on a new vocabulary or in Settings.
  const nameTyped = isNewVocabulary
    ? !!editedName.trim()
    : !!vocabulary && editedName.trim() !== vocabulary.name;
  useUnsavedDraft(nameTyped ? 'The vocabulary name you have typed' : null);

  // Each schema write expects the fields, or the tagsets, this page last read
  // or wrote, so a page opened before another maintainer's save is refused
  // (409) rather than writing over it. The refusal's re-read shows what is
  // stored now.
  const fieldsCell = useConfigCell(storedConfig(vocabulary, IGT_NAMESPACE, 'fields'));
  const tagsetsCell = useConfigCell(storedConfig(vocabulary, IGT_NAMESPACE, 'tagsets'));

  const fetchVocabulary = async (token) => {
    if (isNewVocabulary) {
      setVocabulary({ name: '', config: {} });
      setEditedName('');
      // Seed a new vocab with the full core inventory, the same seed the
      // setup wizard writes. Status is a row of the table below, and like
      // every vocabulary's Status field it cannot be removed.
      setFields(
        normalizeVocabFields(
          statusFieldSeed({ fieldsConfig: seedDefaultFields(), tagsets: {} }).fieldsConfig,
        ),
      );
      setIsEditing(true);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      if (!client) {
        throw new Error('Not authenticated');
      }

      if (!vocabularyId || vocabularyId === 'undefined') {
        throw new Error('Invalid vocabulary ID');
      }

      const vocabularyData = await client.vocabLayers.get(vocabularyId);
      if (token.cancelled) return;
      // The rights are read with the vocabulary, so no tab or control shows
      // before the person's role in its project is known.
      const homeProject = await readHome(vocabularyData.project);
      if (token.cancelled) return;
      setHomeState({ id: vocabularyData.project, project: homeProject });
      setVocabulary(vocabularyData);
      setEditedName(vocabularyData.name);

      // Normalize the field inventory (guarantees immutable morphType).
      setFields(normalizeVocabFields(readVocabFields(vocabularyData.config)));

      setError('');
    } catch (err) {
      if (token.cancelled) return;
      if (err.message === 'Not authenticated' || err.status === 401) {
        logout('expired');
        return;
      }
      setError('Failed to load vocabulary');
      console.error('Error fetching vocabulary:', err);
    } finally {
      if (!token.cancelled) setLoading(false);
    }
  };

  // Comments on this vocabulary's entries live in their own store, shared by
  // the entry panel and the Comments tab, so a comment posted on an entry
  // shows in the tab without a refetch. Owned by the vocabulary, not by any
  // project that links it.
  const comments = useMemo(
    () =>
      client && user && vocabularyId && !isNewVocabulary
        ? new CommentStore({ client, vocabId: vocabularyId, currentUserId: user.id })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, user?.id, vocabularyId, isNewVocabulary],
  );
  useCommentStore(comments);
  useEffect(() => {
    if (!comments) return undefined;
    comments.onError = (msg, err, label) => notifyError(err ?? msg, label);
    comments.load();
  }, [comments]);

  // Who may comment on an entry: a writer or maintainer of its project, or a
  // writer of any project that links this vocabulary. The server decides;
  // this only keeps the composer from being offered to someone it would
  // refuse.
  const writerThroughProject =
    !isNewVocabulary &&
    (projects || []).some(
      (p) => (p.vocabs || []).some((v) => v?.id === vocabularyId) && canEditProject(p, user),
    );
  const canComment = canEditEntries || writerThroughProject;
  // The projects a new vocabulary can be made in, and those this one can
  // move to.
  const maintainedProjects = (projects || []).filter((p) => canManageProject(p, user));
  const newProject = maintainedProjects.find((p) => p.id === newProjectId) ?? null;
  const moveTargets = (projects || []).filter(
    (p) => p.id !== vocabulary?.project && canMoveVocabulary(vocabulary, home, p, user),
  );

  // The history rail: every change to the vocabulary and its entries, and the
  // vocabulary as it was after any of them, read-only on the Entries tab. A
  // maintainer can put one entry back from there.
  const history = useVocabHistory({
    client,
    vocabularyId: isNewVocabulary ? null : vocabularyId,
    onExpired: () => logout('expired'),
  });
  const pastFields = useMemo(
    () =>
      history.past ? normalizeVocabFields(readVocabFields(history.past.vocabulary?.config)) : null,
    [history.past],
  );
  // The entry open is in the address (`?history=`), as a document's is: a link
  // from a document's History opens it here.
  const historyParam = useHistoryParam({
    selectedId: history.selected?.id,
    ready: !!vocabulary && !isNewVocabulary && !!client,
    open: async (id) => {
      if (!id) {
        history.select(null);
        return;
      }
      if (!history.open) history.openHistory();
      try {
        const page = await client.vocabLayers.auditPage(vocabularyId, { entryId: id, opsLimit: 1 });
        const entry = page?.entries?.[0];
        if (!entry) throw new Error('This vocabulary has no such history entry.');
        history.select({
          id: entry.id,
          time: entry.endTime || entry.time,
          label: entry.message || entry.ops?.[0]?.description || '',
        });
      } catch (err) {
        if (statusOf(err) === 401) {
          logout('expired');
          return;
        }
        notifyError(err, 'Failed to open that history entry');
        historyParam.clear();
      }
    },
  });

  // The tab rides in `?tab=`, so a reload or a shared link reopens the same one.
  // Only the tabs this user actually gets are legal values, so a maintainer's
  // link opened by a reader falls back to the item list instead of selecting a
  // tab that isn't there. A brand new vocabulary shows the create form with no
  // tab bar at all, so its fallback never reaches the URL.
  // Base path for the tab links (the item list is the bare vocabulary URL).
  const vocabPath = `/vocabularies/${vocabularyId}`;
  const [activeTab, setActiveTab, tabHref] = useTabParam(
    canManage ? ['items', 'comments', 'settings'] : ['items', 'comments'],
    isNewVocabulary ? 'settings' : 'items',
    // Not ready while the vocabulary and its project are still loading:
    // `canManage` answers false until it knows, so the list starts at two tabs
    // and a bookmarked `?tab=settings` would be corrected away before it was
    // legal.
    { ready: !loading },
  );

  // Read the vocabulary again without the loading state. A read from outside
  // the schema queue waits for it (see WriteQueue.js). `inTurn` is a refused
  // schema write's own refetch, which the queue is waiting on. It throws when
  // it fails, so the queue tries it again.
  const updateVocabulary = async ({ inTurn = false } = {}) => {
    if (isNewVocabulary) return;
    const token = live.current;

    try {
      if (!client) {
        throw new Error('Not authenticated');
      }

      if (!vocabularyId || vocabularyId === 'undefined') {
        throw new Error('Invalid vocabulary ID');
      }

      const read = () => client.vocabLayers.get(vocabularyId);
      const vocabularyData = await (inTurn ? read() : writes.schema.readWhenIdle(read));
      if (token?.cancelled) return;
      // Moved since it was read (a refused move puts it back): the rights
      // are the new project's.
      if (vocabularyData.project !== homeIdRef.current) {
        const homeProject = await readHome(vocabularyData.project);
        if (token?.cancelled) return;
        setHomeState({ id: vocabularyData.project, project: homeProject });
      }
      setVocabulary(vocabularyData);
      setFields(normalizeVocabFields(readVocabFields(vocabularyData.config)));
    } catch (err) {
      if (inTurn) throw err;
      console.error('Error updating vocabulary:', err);
      notifyError(err, 'Failed to load the vocabulary');
    }
  };
  // A refused schema write's refetch, which puts back what the screen showed.
  const resyncSchema = () => updateVocabulary({ inTurn: true });
  // The lexicon's tagsets as stored now, for a refused save's words.
  const readTagsetsNow = async () =>
    storedConfig(await client.vocabLayers.get(vocabularyId), IGT_NAMESPACE, 'tagsets');

  useEffect(() => {
    const token = { cancelled: false };
    live.current = token;
    fetchVocabulary(token);
    return () => {
      token.cancelled = true;
    };
    // Runs once per id; the loader reads the client fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vocabularyId]);

  const handleSave = async () => {
    if (!editedName.trim()) {
      notifyError('Vocabulary name cannot be empty', 'Invalid name');
      return;
    }
    if (isNewVocabulary && !newProject) return;
    // A second click while a create is on its way would read createdRef before
    // the first resolved and make a second vocabulary under the one name.
    if (saving) return;
    setSaving(true);

    try {
      let savedVocabulary;

      if (isNewVocabulary) {
        const name = editedName.trim();
        const fieldsConfig = fieldsToConfig(fields);
        // The list goes in when a field points at it, as the Status field
        // seeded above does.
        const needsStatusTagset = fields.some((f) => f.tagset === STATUS_TAGSET);
        // The layer and its config under ONE operation, so the audit log names
        // the three requests as the single gesture they are. Not atomic, and
        // not restorable: restore takes a document, never a vocab layer.
        await client.withOperation(`Create vocabulary "${name}"`, async () => {
          // A layer a failed attempt already made is finished rather than
          // abandoned, or pressing Create again would leave an unreachable
          // second vocabulary under the same name. The name is reapplied,
          // since it may be what the user changed before retrying.
          if (createdRef.current) {
            savedVocabulary = createdRef.current;
            if (createdRef.current.name !== name) {
              await client.vocabLayers.update(savedVocabulary.id, name);
              createdRef.current = { ...savedVocabulary, name };
            }
          } else {
            // Create names the id it makes and keeps it across presses, so
            // one after an answer that never came cannot make a second.
            savedVocabulary = await createOnce(mintRef, (id) =>
              client.vocabLayers.create(newProject.id, name, undefined, { id }),
            );
            createdRef.current = { ...savedVocabulary, name };
          }
          if (needsStatusTagset) {
            await client.vocabLayers.setConfig(savedVocabulary.id, IGT_NAMESPACE, 'tagsets', {
              [STATUS_TAGSET]: statusTagset(),
            });
          }
          await client.vocabLayers.setConfig(
            savedVocabulary.id,
            IGT_NAMESPACE,
            'fields',
            fieldsConfig,
          );
        });

        navigate(`/vocabularies/${savedVocabulary.id}`, { replace: true });
        notifySuccess('Vocabulary created');
      } else {
        // A new name shows at once and takes its turn in the schema queue. A
        // refused one reloads the vocabulary, which puts the old name back,
        // and leaves the typed name in the field.
        const name = editedName.trim();
        setEditedName(name);
        if (name !== vocabulary.name) {
          setVocabulary((v) => ({ ...v, name }));
          keyedSend(
            writes.schema,
            client,
            `Rename vocabulary "${name}"`,
            () => client.vocabLayers.update(vocabularyId, name),
            {
              refused: (err) => {
                console.error('Error renaming vocabulary:', err);
                notifyError(err, 'Failed to rename the vocabulary');
              },
              resync: resyncSchema,
            },
          );
        }
      }

      setIsEditing(false);
    } catch (err) {
      console.error('Error saving vocabulary:', err);
      notifyError(err, 'Failed to save the vocabulary');
    } finally {
      setSaving(false);
    }
  };

  // Make another project the vocabulary's home. Shown at once, with the
  // rights the person holds there, and put back if refused. The old project
  // keeps it linked, as a project that uses it.
  const [borrowersRead, setBorrowersRead] = useState(0);
  const handleMove = async (targetId) => {
    const target = moveTargets.find((p) => p.id === targetId);
    if (!target || !vocabulary) return;
    const ok = await confirm({
      title: `Move ${quoted(vocabulary.name)} to ${quoted(target.name)}?`,
      description: `${quoted(target.name)} becomes its project. ${quoted(home?.name)} keeps it linked.`,
      confirmLabel: 'Move',
    });
    if (!ok) return;
    setHomeState({ id: target.id, project: target });
    setVocabulary((v) => ({ ...v, project: target.id }));
    const landed = keyedSend(
      writes.schema,
      client,
      // The label is shown on the vocabulary's History to every project that
      // borrows it, so it names no project: core's own description names the
      // target to who may read it.
      `Move vocabulary “${vocabulary.name}”`,
      () => client.vocabLayers.move(vocabularyId, target.id),
      {
        // Core's sentence says what was missing, and the projects are read
        // again: a role taken away meanwhile drops one from the Move list.
        refused: (err) => {
          console.error('Error moving vocabulary:', err);
          notifyError(refusalSaid(err) ?? err, 'Failed to move the vocabulary');
          readProjects();
        },
        resync: resyncSchema,
      },
    );
    // The old project now uses it from outside: the list is read again once
    // the move has landed.
    if (await landed) setBorrowersRead((n) => n + 1);
  };

  const handleAddField = async () => {
    const trimmedName = newFieldName.trim();
    if (!trimmedName) {
      notifyError('Field name cannot be empty', 'Invalid field name');
      return;
    }

    // Check for reserved name
    if (isReservedFieldName(trimmedName)) {
      notifyError(
        `Field name "${trimmedName}" is reserved and cannot be used`,
        'Reserved field name',
      );
      return;
    }

    if (fields.some((f) => sameNameIgnoringCase(f.name, trimmedName))) {
      notifyError('A field with this name already exists', 'Duplicate field name');
      return;
    }

    const proposed = proposeEntryRole(trimmedName);
    await saveFields([
      ...fields,
      {
        ...newVocabField(trimmedName),
        role: statusKey && proposed === ENTRY_ROLES.STATUS ? null : proposed,
      },
    ]);
    setNewFieldName('');
  };

  const handleRemoveField = async (fieldName) => {
    const field = fields.find((f) => f.name === fieldName);
    // belt-and-suspenders; the UI disables the button
    if (field?.immutable || fieldName === statusKey) return;
    await saveFields(fields.filter((f) => f.name !== fieldName));
  };

  const handleToggleInline = async (fieldName) => {
    await saveFields(fields.map((f) => (f.name === fieldName ? { ...f, inline: !f.inline } : f)));
  };

  // The writing system a field's values are in, as the LIFT export labels
  // them. Typed freely, saved when the box is left.
  const [langDrafts, setLangDrafts] = useState({});
  const handleSetLang = async (fieldName) => {
    const draft = langDrafts[fieldName];
    if (draft === undefined) return;
    setLangDrafts((d) => {
      const { [fieldName]: _gone, ...rest } = d;
      return rest;
    });
    const lang = draft.trim() || null;
    const field = fields.find((f) => f.name === fieldName);
    if ((field?.lang || null) === lang) return;
    await saveFields(fields.map((f) => (f.name === fieldName ? { ...f, lang } : f)));
  };

  // Reorder a field by swapping with its neighbor. Immutable fields (morphType)
  // stay pinned first — we never swap into or out of an immutable slot.
  const handleMoveField = async (fieldName, dir) => {
    const idx = fields.findIndex((f) => f.name === fieldName);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= fields.length) return;
    if (fields[idx].immutable || fields[target].immutable) return;
    const next = [...fields];
    [next[idx], next[target]] = [next[target], next[idx]];
    await saveFields(next);
  };

  // Write the schema. The table shows it at once and the write takes its turn
  // in the schema queue. A refused write says so and reloads the vocabulary,
  // which puts back what the table showed. Resolves to whether it landed.
  // A save that sets a field's tagset (`statesTagsets`) states the tagsets
  // this page read in the same batch, so one renamed or deleted elsewhere
  // since refuses it.
  const saveFields = (updatedFields, { statesTagsets = false } = {}) => {
    setFields(updatedFields);
    if (isNewVocabulary) return Promise.resolve(true);
    return keyedSend(
      writes.schema,
      client,
      'Change the fields',
      async () => {
        const value = fieldsToConfig(updatedFields);
        await fieldsCell.write(async (expected) => {
          if (!statesTagsets) {
            await client.vocabLayers.setConfig(
              vocabularyId,
              IGT_NAMESPACE,
              'fields',
              value,
              undefined,
              { expected },
            );
            return value;
          }
          const tagsetsRead = tagsetsCell.expected();
          try {
            await client.batched((b) =>
              queueLexiconFieldsSave(b, vocabularyId, value, {
                fieldsRead: expected,
                statesTagsets: true,
                tagsetsRead,
              }),
            );
          } catch (error) {
            throw await tagsetsChangedError(error, tagsetsRead, readTagsetsNow);
          }
          return value;
        });
      },
      {
        refused: (err) => {
          console.error('Error saving custom fields:', err);
          notifyError(err, 'Failed to save the fields');
        },
        resync: resyncSchema,
      },
    );
  };

  // Point a field at one of the vocabulary's tagsets (or at none). By name,
  // like a project field, so the list is stored once.
  const handleSetTagset = async (fieldName, choice) => {
    const tagset = choice === NO_TAGSET ? null : choice;
    const next = fields.map((f) => (f.name === fieldName ? { ...f, tagset } : f));
    if (refusesStatus(next)) return;
    await saveFields(next, { statesTagsets: true });
  };

  // The reserved Status values: the Status field is never held to a tagset
  // that does not list them, by a tagset chosen or a role moved.
  const refusesStatus = (next) => {
    const refused = dropsReservedStatus({
      fieldsBefore: fields,
      fieldsAfter: next,
      tagsetsBefore: tagsets,
      tagsetsAfter: tagsets,
    });
    if (refused) notifyError(reservedStatusMessage(refused), 'Reserved value');
    return !!refused;
  };

  // What a field holds. A reference field has no tagset (its values are
  // entries), so switching to one lets the tagset go.
  /**
   * What changing `fieldName` to its type in `nextFields` would cost, as
   * `{cleared, trimmed}`: entries whose value goes altogether, and entries
   * holding more references than a single-reference field keeps.
   *
   * Widening one reference to many, and narrowing a single-valued list back,
   * cost nothing: the ids survive the reshape (see `refIds`).
   */
  const countTypeChangeLoss = async (fieldName, nextFields) => {
    const { items = [] } = await writes.entries.readWhenIdle(() =>
      client.vocabLayers.get(vocabularyId, true),
    );
    const live = new Set(items.map((it) => it.id));
    const after = nextFields.find((f) => f.name === fieldName);
    let cleared = 0;
    let trimmed = 0;
    for (const it of items) {
      const raw = it.metadata?.[fieldName];
      if (raw == null || raw === '') continue;
      if (after.type !== FIELD_TYPES.ITEM) {
        cleared += 1;
        continue;
      }
      const ids = refIds(it, after).filter((x) => x !== it.id && live.has(x));
      if (!ids.length) cleared += 1;
      else if (!after.many && ids.length > 1) trimmed += 1;
    }
    return { cleared, trimmed };
  };

  /**
   * Bring every entry's value in `fieldName` into what `after` can hold, and
   * write only what changes. Leaving Entry drops the ids outright, since a
   * text field would show them raw and let anyone type over them. Arriving at
   * Entry keeps the references that resolve, in the new field's own shape, and
   * drops what was never one.
   *
   * Done here rather than left to the entry list's load-time repair: the
   * dialog has just said how many values go, and a promise kept only once a
   * writer next opens that screen is not kept.
   *
   * Takes its turn behind the entry writes, and reads the entries in it.
   * Resolves to whether it landed.
   */
  // A refusal is told to the person by the caller, with what is left to do.
  const pruneFieldValues = (after, label) =>
    sendFieldPrune({
      queue: writes.entries,
      client,
      vocabularyId,
      after,
      label,
      refused: (err) =>
        console.error('Error rewriting entry values after a field type change:', err),
    });

  const handleSetType = async (fieldName, key) => {
    const choice = TYPE_CHOICES.find((c) => c.key === key);
    // The Status field's type is fixed, as its role is: Entry would clear
    // every Status value. The table offers no choice for it.
    if (!choice || fieldName === statusKey) return;
    const before = fields.find((f) => f.name === fieldName);
    const next = fields.map((f) =>
      f.name === fieldName
        ? {
            ...f,
            type: choice.type,
            many: choice.many,
            ...(choice.type === FIELD_TYPES.ITEM ? { tagset: null } : {}),
          }
        : f,
    );
    // Both directions are asked about: values an Entry field cannot hold go,
    // and so do the entry references a Text field cannot hold.
    const touchesRefs = choice.type === FIELD_TYPES.ITEM || before?.type === FIELD_TYPES.ITEM;
    if (touchesRefs && !isNewVocabulary) {
      let cost;
      try {
        cost = await countTypeChangeLoss(fieldName, next);
      } catch (err) {
        console.error('Error reading entries before a field type change:', err);
        notifyError('The entries could not be read.', 'Not changed');
        return;
      }
      const label = fieldLabel(before ?? { name: fieldName });
      const lines = [];
      // Said as what is true of each direction. A text field can hold the
      // strings perfectly well: what it cannot hold is a reference, and that
      // is why they go.
      if (cost.cleared && choice.type === FIELD_TYPES.ITEM)
        lines.push(
          `${cost.cleared} ${cost.cleared === 1 ? 'entry holds a value' : 'entries hold values'} in ${label} that ${choice.label} cannot hold.`,
        );
      if (cost.cleared && choice.type !== FIELD_TYPES.ITEM)
        lines.push(
          `${cost.cleared} ${cost.cleared === 1 ? 'entry holds a reference' : 'entries hold references'} in ${label}. Changing the type to ${choice.label} clears ${cost.cleared === 1 ? 'it' : 'them'}.`,
        );
      if (cost.trimmed)
        lines.push(
          `${cost.trimmed} ${cost.trimmed === 1 ? 'entry holds' : 'entries hold'} more than one reference in ${label}. Only the first is kept.`,
        );
      if (
        lines.length &&
        !(await confirm({
          title: cost.cleared ? `Change ${label}?` : `Keep one reference each?`,
          description: lines.join(' '),
          confirmLabel: 'Change type',
          destructive: true,
        }))
      ) {
        return;
      }
      // The schema goes first, then the values. The other order destroys them
      // for a change that may not land: a failed setConfig would leave the
      // field as it was with every value already gone, and a vocabulary entry
      // has no history to restore from. This way a failure part way through
      // leaves the new type holding values the entry list's load-time repair
      // finishes clearing.
      if (!(await saveFields(next))) return;
      if (
        !(await pruneFieldValues(
          next.find((f) => f.name === fieldName),
          label,
        ))
      ) {
        // Arriving at Entry, the entry list's load-time repair finishes the
        // clearing. Leaving it, nothing else will: the ids stay in a text
        // field until the type is changed again.
        notifyError(
          choice.type === FIELD_TYPES.ITEM
            ? 'Some entries still hold their old value. Open the entries to finish.'
            : 'Some entries still hold their references. Change the type again to finish.',
          label,
        );
      }
      return;
    }
    await saveFields(next);
  };

  const handleSetScope = async (fieldName, scope) => {
    if (fieldName === statusKey) return;
    await saveFields(fields.map((f) => (f.name === fieldName ? { ...f, scope } : f)));
  };

  // What a field's values are (gloss, definition, part of speech, status),
  // for the dictionary, the exports and the assistant. NO_ROLE clears it.
  const handleSetRole = async (fieldName, value) => {
    const role = value === NO_ROLE ? null : value;
    if (fieldName === statusKey || (statusKey && role === ENTRY_ROLES.STATUS)) return;
    const next = fields.map((f) => (f.name === fieldName ? { ...f, role } : f));
    if (refusesStatus(next)) return;
    await saveFields(next);
  };

  // Fields reference a tagset by name, so a rename repoints every field that
  // used the old name in the same batch as the tagsets write, or they would
  // quietly fall back to free. Same contract as the project's TagsetsSettings:
  // a rename or delete that repoints nothing states the fields as read, and
  // a refusal for tagsets changed elsewhere says so. A refused save throws,
  // which is how TagsetsManager learns to roll back.
  const handleSaveTagsets = async (next, meta) => {
    const renamed = meta?.renamed;
    const repointed =
      renamed && fields.some((f) => f.tagset === renamed.from)
        ? fields.map((f) => (f.tagset === renamed.from ? { ...f, tagset: renamed.to } : f))
        : null;
    // The reserved Status values: no save renames or removes one.
    const dropped = dropsReservedStatus({
      fieldsBefore: fields,
      fieldsAfter: repointed ?? fields,
      tagsetsBefore: tagsets,
      tagsetsAfter: next,
    });
    if (dropped) {
      notifyError(reservedStatusMessage(dropped), 'Reserved value');
      throw new Error(reservedStatusMessage(dropped));
    }
    setDraftTagsets(next);
    if (repointed) setFields(repointed);
    const saved = await keyedSend(
      writes.schema,
      client,
      'Change the tagsets',
      () =>
        tagsetsCell.write((tagsetsRead) =>
          fieldsCell
            .write(async (fieldsRead) => {
              const value = repointed ? fieldsToConfig(repointed) : fieldsRead;
              try {
                await client.batched((b) =>
                  queueLexiconTagsetsSave(b, vocabularyId, next, {
                    tagsetsRead,
                    fields: repointed ? value : null,
                    fieldsRead,
                  }),
                );
              } catch (error) {
                throw await tagsetsChangedError(error, tagsetsRead, readTagsetsNow);
              }
              return value;
            })
            .then(() => next),
        ),
      {
        refused: (err) => {
          console.error('Failed to save tagsets:', err);
          notifyError(err, 'Failed to save the tagsets');
          setDraftTagsets(null);
        },
        resync: resyncSchema,
      },
    );
    if (!saved) throw new Error('Failed to save tagsets');
    await updateVocabulary();
    setDraftTagsets(null);
  };

  // The [value, count] rows present in the fields this tagset governs, for
  // the seed button. One fetch of the items, only when asked.
  const handleLoadAttested = async (name) => {
    const names = (tagsetUsage[name] || []).map((g) => g.name);
    if (!names.length) return [];
    const { items = [] } = await writes.entries.readWhenIdle(() =>
      client.vocabLayers.get(vocabularyId, true),
    );
    // [value, count, reading] rows, each entry's values read as its morph
    // type gives (glossReadingOf), as the entry list checks them.
    const tree = buildSenseTree(items);
    const counts = new Map();
    for (const it of items) {
      const reading = glossReadingOf(morphTypeOf(tree, it.id), it.form || null);
      for (const n of names) {
        const v = it.metadata?.[n];
        if (typeof v !== 'string' || !v) continue;
        const key = `${reading ? 'bound' : ''}\u0000${v}`;
        const row = counts.get(key);
        if (row) row[1] += 1;
        else counts.set(key, [v, 1, reading]);
      }
    }
    return [...counts.values()];
  };

  const handleDelete = async () => {
    if (!sameName(confirmDeleteName, vocabulary.name)) {
      notifyError('The entered name does not match the vocabulary name', 'Name does not match');
      return;
    }

    try {
      // Its links go with it, and each morpheme they leave keeps the type
      // its entry gave it, in the same batch (Q1).
      const { items = [] } = (await client.vocabLayers.get(vocabularyId, true)) || {};
      const types = entryMorphTypesOf(items);
      const kept = await planKeptTypes(client, user, { vocabId: vocabularyId }, (id) =>
        types.get(id),
      );
      await client.batched((b) => {
        queueKeptTypes(b, kept);
        b.vocabLayers.delete(vocabularyId);
      });
      closeDeleteModal();
      navigate('/vocabularies');
      notifySuccess('Vocabulary deleted');
    } catch (err) {
      console.error('Error deleting vocabulary:', err);
      const n = otherProjectsOf(err);
      if (n) {
        setDeleteCheck({ otherProjects: n });
        notifyError(otherProjectsSaid(n), 'Failed to delete the vocabulary');
        return;
      }
      notifyError(busyLinkedDocument(err) ?? err, 'Failed to delete the vocabulary');
    }
  };

  // The field table. One row per field, one column per setting, so the eye
  // runs down a column instead of across a ragged line of controls. Type and
  // Tagset needs a saved vocabulary to hold the list.
  const showTagsetCol = !isNewVocabulary;
  const renderCustomFieldsEditor = () => (
    <>
      {fields.length > 0 && (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead>
              {/* The same header as every other table here. */}
              <tr className="bg-muted/50">
                <th className="px-3 py-2 text-left font-medium">Field</th>
                <th className="px-3 py-2 text-left font-medium">Inline</th>
                <th className="px-3 py-2 text-left font-medium">Type</th>
                <th className="px-3 py-2 text-left font-medium">Shown on</th>
                <th className="px-3 py-2 text-left font-medium">Language</th>
                <th className="px-3 py-2 text-left font-medium">Role</th>
                {showTagsetCol && <th className="px-3 py-2 text-left font-medium">Tagset</th>}
                <th className="w-24 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {fields.map((field, idx) => {
                const canMoveUp = idx > 0 && !field.immutable && !fields[idx - 1].immutable;
                const canMoveDown = idx < fields.length - 1 && !field.immutable;
                const isRef = field.type === FIELD_TYPES.ITEM;
                // name-ok: A15 built-in entry key
                const takesTagset = field.name !== 'morphType' && !isRef;
                return (
                  <tr key={field.name} className="border-t hover:bg-muted/30">
                    <td className="px-3 py-1.5">
                      <span className="flex items-center gap-2">
                        <span>{fieldLabel(field)}</span>
                        {field.immutable || field.name === statusKey ? (
                          <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                            Required
                          </span>
                        ) : isBuiltInField(field.name) ? (
                          <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                            Built in
                          </span>
                        ) : null}
                      </span>
                    </td>
                    <td className="px-3 py-1.5">
                      <Switch
                        id={`inline-${field.name}`}
                        aria-label={`Show ${fieldLabel(field)} inline`}
                        checked={field.inline}
                        onCheckedChange={() => handleToggleInline(field.name)}
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      {/* Morph type and the Status field keep their type. */}
                      {field.immutable || field.name === statusKey ? (
                        <span className="text-xs text-muted-foreground">{typeLabelOf(field)}</span>
                      ) : (
                        <Select
                          value={typeChoiceOf(field)}
                          onValueChange={(v) => handleSetType(field.name, v)}
                        >
                          <SelectTrigger
                            id={`type-${field.name}`}
                            aria-label={`Type of ${fieldLabel(field)}`}
                            className="h-7 w-24 text-xs"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {TYPE_CHOICES.map((c) => (
                              <SelectItem key={c.key} value={c.key}>
                                {c.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      {field.immutable || field.name === statusKey ? (
                        <span className="text-xs text-muted-foreground">
                          {SCOPE_LABELS[field.scope]}
                        </span>
                      ) : (
                        <Select
                          value={field.scope}
                          onValueChange={(v) => handleSetScope(field.name, v)}
                        >
                          <SelectTrigger
                            id={`scope-${field.name}`}
                            aria-label={`Where ${fieldLabel(field)} is shown`}
                            className="h-7 w-36 text-xs"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={FIELD_SCOPES.SENSE}>Every sense</SelectItem>
                            <SelectItem value={FIELD_SCOPES.ENTRY}>Headword only</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      {/* A morph type is a fixed list and a reference field's
                          values are entries: neither is in a language. The
                          required gloss IS, and it is the one that matters. */}
                      {/* name-ok: A15 built-in entry key */}
                      {field.name !== 'morphType' && !isRef && (
                        <Input
                          value={langDrafts[field.name] ?? field.lang ?? ''}
                          aria-label={`Language of ${fieldLabel(field)}`}
                          className="h-7 w-20 text-xs"
                          onChange={(e) =>
                            setLangDrafts((d) => ({ ...d, [field.name]: e.target.value }))
                          }
                          onBlur={() => handleSetLang(field.name)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') e.currentTarget.blur();
                          }}
                        />
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      {/* The field holding the Status role keeps it. Morph type
                          and a reference field take no role, as they take no
                          tagset (`takesTagset`). */}
                      {field.name === statusKey ? (
                        <span className="text-xs text-muted-foreground">Status</span>
                      ) : takesTagset ? (
                        <Select
                          value={field.role ?? NO_ROLE}
                          onValueChange={(v) => handleSetRole(field.name, v)}
                        >
                          <SelectTrigger
                            id={`role-${field.name}`}
                            aria-label={`Role of ${fieldLabel(field)}`}
                            className="h-7 w-36 text-xs"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NO_ROLE}>None</SelectItem>
                            {roleChoices.map((c) => (
                              <SelectItem key={c.role} value={c.role}>
                                {c.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    {showTagsetCol && (
                      <td className="px-3 py-1.5">
                        {/* Morph type is its own fixed list, and a reference
                            field's values are entries; neither takes a
                            tagset. A dangling name stays selectable so the
                            picker shows what is stored rather than reading as
                            "none" and overwriting it. */}
                        {takesTagset && (tagsetNames.length > 0 || field.tagset) ? (
                          <Select
                            value={field.tagset ?? NO_TAGSET}
                            onValueChange={(v) => handleSetTagset(field.name, v)}
                          >
                            <SelectTrigger
                              id={`tagset-${field.name}`}
                              aria-label={`Tagset of ${fieldLabel(field)}`}
                              className="h-7 w-36 text-xs"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={NO_TAGSET}>None</SelectItem>
                              {tagsetNames.map((n) => (
                                <SelectItem key={n} value={n}>
                                  {n}
                                </SelectItem>
                              ))}
                              {field.tagset && !tagsetNames.includes(field.tagset) && (
                                <SelectItem value={field.tagset}>
                                  {field.tagset} (missing)
                                </SelectItem>
                              )}
                            </SelectContent>
                          </Select>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    )}
                    <td className="px-3 py-1.5">
                      <div className="flex justify-end">
                        <RowControls
                          name={fieldLabel(field)}
                          onUp={() => handleMoveField(field.name, -1)}
                          onDown={() => handleMoveField(field.name, 1)}
                          canUp={canMoveUp}
                          canDown={canMoveDown}
                          onRemove={() => handleRemoveField(field.name)}
                          canRemove={!field.immutable && field.name !== statusKey}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Input
          placeholder="New field name"
          value={newFieldName}
          onChange={(event) => setNewFieldName(event.target.value)}
          className="max-w-md flex-1"
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              handleAddField();
            }
          }}
        />
        <Button onClick={handleAddField} disabled={!newFieldName.trim()}>
          <Plus className="h-4 w-4" /> Add field
        </Button>
      </div>
    </>
  );

  if (loading) {
    return <Loading label="Loading vocabulary…" />;
  }

  if (error) {
    return (
      <Notice tone="error">
        <p className="font-medium">Failed to load the vocabulary</p>
        <p>{error}</p>
      </Notice>
    );
  }

  if (!vocabulary && !isNewVocabulary) {
    return (
      <Notice tone="error">
        <p className="font-medium">Vocabulary not found</p>
      </Notice>
    );
  }

  // R58: made by an import that did not finish, it does not open until that
  // import is deleted (or, never, finished). Its project offers the Delete.
  if (!isNewVocabulary && vocabImporting(vocabulary?.config) && !staleMark) {
    const projectId = markedFor;
    const unreadable = markState === 'unreadable';
    return (
      <Notice role="status" icon={null}>
        <p>This vocabulary belongs to an import that did not finish.</p>
        {projectId && !unreadable && (
          <Link className="underline" to={`/projects/${projectId}`}>
            Open its project
          </Link>
        )}
        {unreadable && <p>Its project cannot be opened.</p>}
        {unreadable && canManage && (
          <Button size="sm" className="mt-2" onClick={detachFromImport}>
            Detach from import
          </Button>
        )}
      </Notice>
    );
  }

  // A pick in the rail shows the Entries tab, the one place a past state is
  // drawn. The others stay on the vocabulary as it is now.
  const selectPast = (entry) => {
    if (entry && activeTab !== 'items') setActiveTab('items');
    historyParam.select(entry?.id ?? null);
    history.select(entry);
  };
  const viewingPast = !!history.selected;
  // An entry, or an action inside one, opens on what it changed, the
  // vocabulary as of it one click away.
  const changesShown = !!history.selected;
  const showChanges = changesShown && historyParam.view === 'changes';

  return (
    <div
      className="transition-[margin] duration-200"
      style={{ marginLeft: history.open ? HISTORY_DRAWER_WIDTH : 0 }}
    >
      <HistoryDrawer
        isOpen={history.open}
        onClose={history.closeHistory}
        auditEntries={history.entries}
        loading={history.loading}
        error={history.error}
        onSelectEntry={selectPast}
        selectedEntry={history.selected}
      />
      <div className="flex flex-col gap-6">
        <Breadcrumb items={[{ label: 'Vocabularies', to: '/vocabularies', fixed: true }]} />

        {!isNewVocabulary && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-4">
              <h1 dir="auto" className={cn('min-w-0 truncate font-text', TYPE.page)}>
                {vocabulary?.name}
              </h1>
              <div className="flex shrink-0 items-center gap-2">
                <SaveStatus doc={saveStatus} />
                {/* Not a tab: the rail keeps whatever tab is open, the way a
                  document's History does. */}
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0 gap-1.5"
                  onClick={() =>
                    history.open && !history.itemId ? history.closeHistory() : history.openHistory()
                  }
                  aria-expanded={history.open && !history.itemId}
                >
                  <History className="h-4 w-4" /> History
                </Button>
              </div>
            </div>
            <p className="-mt-2 text-sm text-muted-foreground">
              Project:{' '}
              {home ? (
                <Link to={`/projects/${home.id}`} dir="auto" className="font-text hover:underline">
                  {home.name}
                </Link>
              ) : (
                'another project'
              )}
            </p>
            {viewingPast && (
              <Notice tone="warning" icon={Info}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {showChanges
                      ? `Changes made in this entry, ${fullTimestamp(history.selected.time)}.`
                      : history.loadingPast
                        ? `Loading the vocabulary as of ${fullTimestamp(history.selected.time)}…`
                        : `Read-only. This is the vocabulary as of ${fullTimestamp(history.past?.time ?? history.selected.time)}.`}
                  </span>
                  {changesShown && (
                    <SegmentedControl
                      label="View"
                      value={historyParam.view}
                      onChange={historyParam.setView}
                      options={[
                        { value: 'changes', label: 'Changes' },
                        { value: 'document', label: 'Vocabulary' },
                      ]}
                    />
                  )}
                </div>
              </Notice>
            )}
          </div>
        )}

        {!isNewVocabulary && showChanges && (
          <VocabHistoryChanges
            client={client}
            vocabularyId={vocabularyId}
            entry={history.selected}
            past={history.loadingPast ? null : history.past}
          />
        )}

        {!isNewVocabulary && !isEditing && !showChanges && (
          <Tabs value={activeTab} onValueChange={setActiveTab} guard={guardLeavingTab}>
            <TabsList>
              <TabsTrigger value="items" to={tabHref(vocabPath, 'items')}>
                <BookText className="h-4 w-4" /> Entries
              </TabsTrigger>
              <TabsTrigger
                value="comments"
                to={tabHref(vocabPath, 'comments')}
                disabled={viewingPast}
                className={PAST_DISABLED}
              >
                <MessageSquare className="h-4 w-4" /> Comments
                {(comments?.count ?? 0) > 0 && (
                  <span className="ml-1 rounded-full bg-muted px-1.5 text-[10px] leading-4 tabular-nums">
                    {comments.count}
                  </span>
                )}
              </TabsTrigger>
              {canManage && (
                <TabsTrigger
                  value="settings"
                  to={tabHref(vocabPath, 'settings')}
                  disabled={viewingPast}
                  className={PAST_DISABLED}
                >
                  <Settings className="h-4 w-4" /> Settings
                </TabsTrigger>
              )}
            </TabsList>

            <TabsContent value="items">
              <VocabularyItems
                vocabularyId={vocabularyId}
                vocabulary={vocabulary}
                client={client}
                fields={pastFields ?? fields}
                writes={writes.entries}
                canEditEntries={canEditEntries}
                canManage={canManage}
                readOnlyNote={entriesReadOnlyNote(role, home?.name)}
                comments={comments}
                canComment={canComment}
                past={history.past}
                historyPending={viewingPast && !history.past}
                canRestore={canManage}
                onRestored={history.backToNow}
                onOpenHistory={history.openHistory}
                historyItemId={history.itemId}
              />
            </TabsContent>

            <TabsContent value="comments">
              <VocabularyCommentsTab
                vocabularyId={vocabularyId}
                client={client}
                store={comments}
                fields={fields}
                canWrite={canComment}
                canDeleteAny={canManage}
              />
            </TabsContent>

            {canManage && (
              <TabsContent value="settings">
                <div className="flex flex-col gap-6">
                  {/* The alphabet is set in the dictionary reader, not here, and
                    nothing in this app said so. A lexicographer found the entry
                    list in the wrong order, had no idea an alphabet could be
                    declared at all, and only found the control by opening the
                    other app. Say where it is. */}
                  <p className="text-sm text-muted-foreground">
                    Entries here are listed in your language’s default order. A vocabulary’s own
                    alphabet files letters like ẹ and n-graphs like ch where the language puts them.
                    Set one in the dictionary reader, on its Set up page. That order applies to the
                    published dictionary.
                  </p>
                  <div className="rounded-lg border bg-card p-4">
                    <div className="flex flex-col gap-4">
                      <h3 className="text-base font-semibold">Settings</h3>

                      <div className="flex items-end gap-2">
                        <div className="flex flex-1 flex-col gap-1.5">
                          <Label htmlFor="vocabulary-rename">Vocabulary name</Label>
                          <Input
                            id="vocabulary-rename"
                            placeholder="Enter vocabulary name"
                            value={editedName}
                            onChange={(event) => setEditedName(event.target.value)}
                          />
                        </div>
                        <Button
                          onClick={handleSave}
                          disabled={!editedName.trim() || editedName === vocabulary?.name}
                        >
                          Save
                        </Button>
                      </div>
                      {moveTargets.length > 0 && (
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor="vocabulary-move">Move to project</Label>
                          {/* Holds no choice: picking a project asks, then moves. */}
                          <Select value="" onValueChange={handleMove}>
                            <SelectTrigger id="vocabulary-move" className="max-w-md">
                              <SelectValue placeholder="Choose a project" />
                            </SelectTrigger>
                            <SelectContent>
                              {moveTargets.map((p) => (
                                <SelectItem key={p.id} value={p.id}>
                                  <span dir="auto">{p.name}</span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="rounded-lg border bg-card p-4">
                    <div className="flex flex-col gap-4">
                      <h3 className="text-base font-semibold">Fields</h3>
                      <p className="text-sm text-muted-foreground">
                        Every entry has these fields. <strong>Inline</strong> puts a field in the
                        interlinear view as well. A tagset, defined below, holds a field to a list.
                        An <strong>Entry</strong> or <strong>Entries</strong> field refers to other
                        entries, senses included. <strong>Headword only</strong> shows a field on a
                        headword, not on its senses.
                      </p>

                      {renderCustomFieldsEditor()}
                    </div>
                  </div>

                  <div className="rounded-lg border bg-card p-4">
                    <div className="flex flex-col gap-4">
                      <h3 className="text-base font-semibold">Tagsets</h3>
                      <p className="text-sm text-muted-foreground">
                        A tagset is the list of values a field may hold, such as the part of speech
                        inventory. Assign it to a field above. A closed tagset keeps every entry to
                        the list, in the editor and in Bulk Add, and marks the entries already
                        outside it.
                      </p>
                      <TagsetsManager
                        tagsets={tagsets}
                        usage={tagsetUsage}
                        reservedValues={
                          statusTagsetName(fields)
                            ? { [statusTagsetName(fields)]: RESERVED_STATUS_VALUES }
                            : {}
                        }
                        reservedMessage={reservedStatusMessage}
                        onSaveChanges={handleSaveTagsets}
                        onLoadAttested={handleLoadAttested}
                        emptyHint="No tagsets yet. Add one, then assign it to a field above."
                        seedLabel="Add values used in this vocabulary"
                        valuesNoun="entries"
                        enforceNote="Closed lists apply to what you type here and to Bulk Add. Values from an import or a service are not checked. The entry list marks them."
                      />
                    </div>
                  </div>

                  <VocabularyBorrowers
                    // A move makes the old project one of them.
                    key={borrowersRead}
                    client={client}
                    user={user}
                    vocabulary={vocabulary}
                    home={home}
                  />

                  <div className="border-t" />

                  <div className="rounded-lg border border-destructive/40 p-4">
                    <div className="flex flex-col gap-4">
                      <h3 className="text-base font-semibold">Danger zone</h3>
                      <p className="text-sm text-muted-foreground">
                        Delete this vocabulary permanently. This action cannot be undone.
                      </p>
                      <div>
                        <Button
                          variant="outline"
                          className={DELETE_BUTTON_CLASS}
                          onClick={openDeleteModal}
                        >
                          <Trash2 className="h-4 w-4" /> Delete vocabulary
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              </TabsContent>
            )}
          </Tabs>
        )}

        {isNewVocabulary && (
          <div className="flex flex-col gap-6">
            <h1 className={TYPE.page}>New vocabulary</h1>

            <div className="rounded-lg border bg-card p-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="vocabulary-new-name">
                  Vocabulary name <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="vocabulary-new-name"
                  placeholder="Enter vocabulary name"
                  value={editedName}
                  onChange={(event) => setEditedName(event.target.value)}
                  autoFocus
                />
                <p className="text-xs text-muted-foreground">
                  Choose a descriptive name for your vocabulary
                </p>
                {editedName && !editedName.trim() && (
                  <p className="text-xs text-destructive">Name cannot be empty</p>
                )}
              </div>
              <div className="mt-4 flex flex-col gap-1.5">
                <Label htmlFor="vocabulary-new-project">
                  Project <span className="text-destructive">*</span>
                </Label>
                <Select value={newProject ? newProject.id : ''} onValueChange={setNewProjectId}>
                  <SelectTrigger
                    id="vocabulary-new-project"
                    className="max-w-md"
                    disabled={!maintainedProjects.length}
                  >
                    <SelectValue
                      placeholder={
                        projects && !maintainedProjects.length
                          ? 'No project you maintain.'
                          : 'Choose a project'
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {maintainedProjects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        <span dir="auto">{p.name}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="rounded-lg border bg-card p-4">
              <div className="flex flex-col gap-4">
                <h3 className="text-base font-semibold">Fields</h3>
                <p className="text-sm text-muted-foreground">
                  Every entry has these fields. <strong>Inline</strong> puts a field in the
                  interlinear view as well. An <strong>Entry</strong> or <strong>Entries</strong>{' '}
                  field refers to other entries, senses included. <strong>Headword only</strong>{' '}
                  shows a field on a headword, not on its senses.
                </p>

                {renderCustomFieldsEditor()}
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => navigate('/vocabularies')}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={!editedName.trim() || !newProject || saving}>
                Create vocabulary
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      <Dialog
        open={deleteModalOpened}
        onOpenChange={(o) => {
          if (!o) closeDeleteModal();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete vocabulary?</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            {deleteCheck?.otherProjects ? (
              // Only a maintainer of its project opens this, and they end
              // each borrowing on this tab.
              <p className="text-sm">
                {otherProjectsSaid(deleteCheck.otherProjects)} Unlink it from{' '}
                {deleteCheck.otherProjects === 1 ? 'that project' : 'them'} under Used by other
                projects first.
              </p>
            ) : (
              <>
                <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                    <div className="text-sm">
                      <p className="text-muted-foreground">
                        Deletes <strong>“{vocabulary?.name}”</strong> with all its entries and their
                        links. This cannot be undone.
                      </p>
                      {deleteCheck?.links > 0 && (
                        <p className="mt-1 text-muted-foreground">
                          Its entries are linked to{' '}
                          <strong>
                            {countOf(deleteCheck.links, 'word')}/
                            {plural(deleteCheck.links, 'morpheme')}
                          </strong>
                          . Those links will be removed.
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="vocabulary-delete-confirm">
                    Type “{vocabulary?.name}” to confirm
                  </Label>
                  <Input
                    id="vocabulary-delete-confirm"
                    placeholder="Enter vocabulary name"
                    value={confirmDeleteName}
                    onChange={(event) => setConfirmDeleteName(event.target.value)}
                  />
                </div>
              </>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                closeDeleteModal();
                setConfirmDeleteName('');
              }}
            >
              Cancel
            </Button>
            {!deleteCheck?.otherProjects && (
              <Button
                variant="destructive"
                onClick={handleDelete}
                disabled={
                  deleteCheck === undefined || !sameName(confirmDeleteName, vocabulary?.name)
                }
              >
                <Trash2 className="h-4 w-4" /> Delete vocabulary
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
