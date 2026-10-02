import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  BookText,
  Users,
  Settings,
  Trash2,
  Plus,
  ChevronUp,
  ChevronDown,
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
import { readVocabFields, IGT_NAMESPACE } from '@/domain/igtConfig';
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
} from '@/domain/vocabFields';
import {
  buildSenseTree,
  morphTypeOf,
  refIds,
  statusTagset,
  statusFieldSeed,
  STATUS_TAGSET,
} from '@/domain/vocabDictionary';
import { sendFieldPrune, sendKeyed } from './vocabSends.js';
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
import { useConfigCell } from '@ui/hooks/useConfigCell.js';
import { VocabularyItems } from './VocabularyItems';
import { VocabularyMaintainers } from './VocabularyMaintainers';
import { VocabularyCommentsTab } from './VocabularyCommentsTab';
import { CommentStore } from '@ui/domain/CommentStore';
import { useCommentStore } from '@ui/domain/useCommentStore';
import { canEditProject, canManageVocabulary } from '@ui/domain/permissions.js';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { useSavingGuard } from '@ui/hooks/useSavingGuard.js';
import { useUnsavedGuard } from '@ui/hooks/useUnsavedDraft.js';
import { queuesStatus, vocabWriteQueue } from './vocabWriteQueue.js';
import { SaveStatus } from '@ui/components/shared/SaveStatus.jsx';
import { createOnce } from '@ui/lib/createOnce.js';
import { useTabParam } from '@/hooks/useTabParam';
import { Loading } from '@ui/components/shared/Loading.jsx';
import { Notice } from '@ui/components/shared/Notice.jsx';
import { Breadcrumb } from '@ui/components/shared/Breadcrumb.jsx';
import { DELETE_BUTTON_CLASS } from '@ui/lib/destructive.js';
import { HistoryDrawer, HISTORY_DRAWER_WIDTH } from '@ui/components/shared/HistoryDrawer.jsx';
import { fullTimestamp } from '@ui/lib/formatTime.js';
import { useVocabHistory } from './useVocabHistory';

// A tab the past state does not reach. The trigger is an anchor, which the
// `disabled:` variant does not match, so it keys on Radix's data attribute.
const PAST_DISABLED = 'data-[disabled]:pointer-events-none data-[disabled]:opacity-50';

// Radix Select has no empty-string item value, so "no tagset" needs a sentinel.
const NO_TAGSET = '__none__';

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

export const VocabularyDetail = () => {
  const { vocabularyId } = useParams();
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
  // The id a new vocabulary's create names is kept across presses of Create
  // for one name only (createOnce.js).
  useEffect(() => {
    mintRef.current = null;
  }, [editedName]);
  // Normalized field inventory: [{name, inline, immutable}], morphType always present.
  const [fields, setFields] = useState([]);
  const [newFieldName, setNewFieldName] = useState('');
  // The vocabulary's own tagsets (config.igt.tagsets, the project's shape).
  // Held here between a save and the refetch so the editor does not flicker
  // back to the pre-save list in between.
  const [draftTagsets, setDraftTagsets] = useState(null);
  const tagsets = draftTagsets ?? readTagsets(vocabulary?.config);
  const tagsetNames = Object.keys(tagsets);
  // Which fields point at which tagset: the delete warning, the rename
  // repoint and the seed all read this.
  const tagsetUsage = useMemo(
    () => byTagsetName(vocabGovernedFields(fields, vocabulary?.config)),
    [fields, vocabulary],
  );
  const [deleteModalOpened, setDeleteModalOpened] = useState(false);
  const openDeleteModal = () => setDeleteModalOpened(true);
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

  // Each schema write expects the fields, or the tagsets, this page last read
  // or wrote, so a page opened before another maintainer's save is refused
  // (409) rather than writing over it. The refusal's re-read shows what is
  // stored now.
  const fieldsCell = useConfigCell(storedConfig(vocabulary, IGT_NAMESPACE, 'fields'));
  const tagsetsCell = useConfigCell(storedConfig(vocabulary, IGT_NAMESPACE, 'tagsets'));

  const fetchVocabulary = async (token) => {
    if (isNewVocabulary) {
      setVocabulary({
        name: '',
        config: {},
        maintainers: [user?.id].filter(Boolean),
      });
      setEditedName('');
      // Seed a new vocab with the full core inventory, the same seed the
      // setup wizard writes. Status is a row like any other, so the table
      // below really is "these fields": a vocabulary that wants no editorial
      // status can remove it here, before the vocabulary exists.
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
      setVocabulary(vocabularyData);
      setEditedName(vocabularyData.name);

      // Normalize the field inventory (guarantees immutable morphType, tolerates
      // the legacy boolean format).
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

  // Who may comment on an entry is who may edit one: a maintainer or admin,
  // or a writer of a project that links this vocabulary. The server decides;
  // this only keeps the composer from being offered to someone it would
  // refuse.
  const [writerThroughProject, setWriterThroughProject] = useState(false);
  useEffect(() => {
    if (!client || !user || !vocabularyId || isNewVocabulary) return undefined;
    let alive = true;
    client.projects
      .list()
      .then((projects) => {
        if (!alive) return;
        setWriterThroughProject(
          projects.some(
            (p) =>
              (p.vocabs || []).some((v) => (v?.id ?? v) === vocabularyId) &&
              canEditProject(p, user),
          ),
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [client, user, vocabularyId, isNewVocabulary]);
  const canComment = canManageVocabulary(vocabulary, user) || writerThroughProject;

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

  // The tab rides in `?tab=`, so a reload or a shared link reopens the same one.
  // Only the tabs this user actually gets are legal values, so a maintainer's
  // link opened by a reader falls back to the item list instead of selecting a
  // tab that isn't there. A brand new vocabulary shows the create form with no
  // tab bar at all, so its fallback never reaches the URL.
  // Base path for the tab links (the item list is the bare vocabulary URL).
  const vocabPath = `/vocabularies/${vocabularyId}`;
  const [activeTab, setActiveTab, tabHref] = useTabParam(
    canManageVocabulary(vocabulary, user)
      ? ['items', 'comments', 'maintainers', 'settings']
      : ['items', 'comments'],
    isNewVocabulary ? 'settings' : 'items',
    // Not ready while the vocabulary is still loading: `canManageVocabulary`
    // answers false until it knows, so the list starts at two tabs and a
    // bookmarked `?tab=settings` would be corrected away before it was legal.
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
    // A second click while a create is on its way would read createdRef before
    // the first resolved and make a second vocabulary under the one name.
    if (saving) return;
    setSaving(true);

    try {
      let savedVocabulary;

      if (isNewVocabulary) {
        const name = editedName.trim();
        const fieldsConfig = fieldsToConfig(fields);
        // The list only goes in when a field points at it, since Status is a
        // row the user may have removed above.
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
              client.vocabLayers.create(name, undefined, { id }),
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
          sendKeyed(
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

    // Check for duplicate names (case insensitive)
    if (fields.some((f) => f.name.toLowerCase() === trimmedName.toLowerCase())) {
      notifyError('A field with this name already exists', 'Duplicate field name');
      return;
    }

    await saveFields([...fields, newVocabField(trimmedName)]);
    setNewFieldName('');
  };

  const handleRemoveField = async (fieldName) => {
    const field = fields.find((f) => f.name === fieldName);
    if (field?.immutable) return; // belt-and-suspenders; the UI hides the button
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
  const saveFields = (updatedFields) => {
    setFields(updatedFields);
    if (isNewVocabulary) return Promise.resolve(true);
    return sendKeyed(
      writes.schema,
      client,
      'Change the fields',
      async () => {
        const value = fieldsToConfig(updatedFields);
        await fieldsCell.write(async (expected) => {
          await client.vocabLayers.setConfig(
            vocabularyId,
            IGT_NAMESPACE,
            'fields',
            value,
            undefined,
            { expected },
          );
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
    await saveFields(fields.map((f) => (f.name === fieldName ? { ...f, tagset } : f)));
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
    if (!choice) return;
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
    await saveFields(fields.map((f) => (f.name === fieldName ? { ...f, scope } : f)));
  };

  // Fields reference a tagset by name, so a rename repoints every field that
  // used the old name right behind it, or they quietly fall back to free.
  // Same contract as the project's TagsetsSettings. Both take their turn in
  // the schema queue. A refused tagsets write throws, which is how
  // TagsetsManager learns to roll back. A refused repoint does not: the
  // tagsets the manager shows are the server's, and the refusal's own
  // re-read shows the fields as the server holds them.
  const handleSaveTagsets = async (next, meta) => {
    setDraftTagsets(next);
    const tagsetsLanded = sendKeyed(
      writes.schema,
      client,
      'Change the tagsets',
      () =>
        tagsetsCell.write(async (expected) => {
          await client.vocabLayers.setConfig(
            vocabularyId,
            IGT_NAMESPACE,
            'tagsets',
            next,
            undefined,
            {
              expected,
            },
          );
          return next;
        }),
      {
        refused: (err) => {
          console.error('Failed to save tagsets:', err);
          notifyError(err, 'Failed to save the tagsets');
          setDraftTagsets(null);
        },
        resync: resyncSchema,
      },
    );
    const renamed = meta?.renamed;
    const fieldsLanded =
      renamed && fields.some((f) => f.tagset === renamed.from)
        ? saveFields(
            fields.map((f) => (f.tagset === renamed.from ? { ...f, tagset: renamed.to } : f)),
          )
        : true;
    const tagsetsSaved = await tagsetsLanded;
    await fieldsLanded;
    if (!tagsetsSaved) throw new Error('Failed to save tagsets');
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
    if (confirmDeleteName !== vocabulary.name) {
      notifyError('The entered name does not match the vocabulary name', 'Name does not match');
      return;
    }

    try {
      await client.vocabLayers.delete(vocabularyId);
      closeDeleteModal();
      navigate('/vocabularies');
      notifySuccess('Vocabulary deleted');
    } catch (err) {
      console.error('Error deleting vocabulary:', err);
      notifyError(err, 'Failed to delete the vocabulary');
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
                {showTagsetCol && <th className="px-3 py-2 text-left font-medium">Tagset</th>}
                <th className="w-24 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {fields.map((field, idx) => {
                const canMoveUp = idx > 0 && !field.immutable && !fields[idx - 1].immutable;
                const canMoveDown = idx < fields.length - 1 && !field.immutable;
                const isRef = field.type === FIELD_TYPES.ITEM;
                const takesTagset = field.name !== 'morphType' && !isRef;
                return (
                  <tr key={field.name} className="border-t hover:bg-muted/30">
                    <td className="px-3 py-1.5">
                      <span className="flex items-center gap-2">
                        <span>{fieldLabel(field)}</span>
                        {field.immutable ? (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                            Required
                          </span>
                        ) : isBuiltInField(field.name) ? (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
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
                      {field.immutable ? (
                        <span className="text-xs text-muted-foreground">Text</span>
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
                      {field.immutable ? (
                        <span className="text-xs text-muted-foreground">Every sense</span>
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
                      <div className="flex items-center justify-end gap-0.5 text-muted-foreground">
                        <button
                          type="button"
                          aria-label="Move up"
                          disabled={!canMoveUp}
                          onClick={() => handleMoveField(field.name, -1)}
                          className="rounded p-1 hover:text-foreground disabled:opacity-25 disabled:hover:text-muted-foreground"
                        >
                          <ChevronUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label="Move down"
                          disabled={!canMoveDown}
                          onClick={() => handleMoveField(field.name, 1)}
                          className="rounded p-1 hover:text-foreground disabled:opacity-25 disabled:hover:text-muted-foreground"
                        >
                          <ChevronDown className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove ${fieldLabel(field)}`}
                          disabled={field.immutable}
                          onClick={() => handleRemoveField(field.name)}
                          className="rounded p-1 hover:text-destructive disabled:opacity-25 disabled:hover:text-muted-foreground"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
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

  // A pick in the rail shows the Entries tab, the one place a past state is
  // drawn. The others stay on the vocabulary as it is now.
  const selectPast = (entry) => {
    if (entry && activeTab !== 'items') setActiveTab('items');
    history.select(entry);
  };
  const viewingPast = !!history.selected;

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
              <h1 dir="auto" className="min-w-0 truncate text-2xl font-bold">
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
            {viewingPast && (
              <Notice tone="warning" icon={Info}>
                {history.loadingPast
                  ? `Loading the vocabulary as of ${fullTimestamp(history.selected.time)}…`
                  : `Read-only. This is the vocabulary as of ${fullTimestamp(history.selected.time)}.`}
              </Notice>
            )}
          </div>
        )}

        {!isNewVocabulary && !isEditing && (
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
              {canManageVocabulary(vocabulary, user) && (
                <TabsTrigger
                  value="maintainers"
                  to={tabHref(vocabPath, 'maintainers')}
                  disabled={viewingPast}
                  className={PAST_DISABLED}
                >
                  <Users className="h-4 w-4" /> Maintainers
                </TabsTrigger>
              )}
              {canManageVocabulary(vocabulary, user) && (
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
                canManage={canManageVocabulary(vocabulary, user)}
                comments={comments}
                canComment={canComment}
                past={history.past}
                historyPending={viewingPast && !history.past}
                canRestore={canManageVocabulary(vocabulary, user)}
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
                canDeleteAny={canManageVocabulary(vocabulary, user)}
              />
            </TabsContent>

            {canManageVocabulary(vocabulary, user) && (
              <TabsContent value="maintainers">
                <VocabularyMaintainers
                  vocabulary={vocabulary}
                  user={user}
                  vocabularyId={vocabularyId}
                  client={client}
                  onDataUpdate={updateVocabulary}
                />
              </TabsContent>
            )}

            {canManageVocabulary(vocabulary, user) && (
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
                          <Label>Vocabulary name</Label>
                          <Input
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
                        onSaveChanges={handleSaveTagsets}
                        onLoadAttested={handleLoadAttested}
                        emptyHint="No tagsets yet. Add one, then assign it to a field above."
                        seedLabel="Add values used in this vocabulary"
                        valuesNoun="entries"
                        enforceNote="Closed lists apply to what you type here and to Bulk Add. Values from an import or a service are not checked. The entry list marks them."
                      />
                    </div>
                  </div>

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
            <h2 className="text-lg font-semibold">New vocabulary</h2>

            <div className="rounded-lg border bg-card p-4">
              <div className="flex flex-col gap-1.5">
                <Label>
                  Vocabulary name <span className="text-destructive">*</span>
                </Label>
                <Input
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
              <Button onClick={handleSave} disabled={!editedName.trim() || saving}>
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
            <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <div className="text-sm">
                  <p className="text-muted-foreground">
                    Deletes <strong>“{vocabulary?.name}”</strong> with all its entries and their
                    links. This cannot be undone.
                  </p>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Type “{vocabulary?.name}” to confirm</Label>
              <Input
                placeholder="Enter vocabulary name"
                value={confirmDeleteName}
                onChange={(event) => setConfirmDeleteName(event.target.value)}
              />
            </div>
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
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={confirmDeleteName !== vocabulary?.name}
            >
              <Trash2 className="h-4 w-4" /> Delete vocabulary
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
