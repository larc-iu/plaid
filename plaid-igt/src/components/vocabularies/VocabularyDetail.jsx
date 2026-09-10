import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
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
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { readVocabFields, IGT_NAMESPACE } from '@/domain/igtConfig';
import {
  normalizeVocabFields,
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
  refIds,
  withRefIds,
  statusTagset,
  statusFieldSeed,
  STATUS_TAGSET,
} from '@/domain/vocabDictionary';
import { readTagsets, byTagsetName } from '@/domain/tagsets';
import { TagsetsManager } from '@/components/projects/settings/TagsetsManager.jsx';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { notifySuccess, notifyError, humanizeError } from '@/utils/feedback';
import { VocabularyItems } from './VocabularyItems';
import { VocabularyMaintainers } from './VocabularyMaintainers';
import { VocabularyCommentsTab } from './VocabularyCommentsTab';
import { CommentStore } from '@/domain/CommentStore';
import { useCommentStore } from '@/domain/useCommentStore';
import { canEditProject } from '@/utils/permissions';
import { useConfirm } from '@/components/shared/ConfirmProvider';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useTabParam, tabTo } from '@/hooks/useTabParam';

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
const FIELD_CLEAR_CHUNK = 100;

export const VocabularyDetail = () => {
  const { vocabularyId } = useParams();
  const navigate = useNavigate();
  // The layer a failed creation already made, so pressing Create again
  // finishes it instead of leaving an unreachable second one behind.
  const createdRef = useRef(null);
  // A save in flight, so a second click cannot start another one.
  const [saving, setSaving] = useState(false);
  const confirm = useConfirm();
  const { user, client, logout } = useAuth();
  const isNewVocabulary = !vocabularyId;

  const [vocabulary, setVocabulary] = useState(null);
  // New vocab: a fixed label; existing: the loaded name (null while loading).
  useDocumentTitle(isNewVocabulary ? 'New Vocabulary' : vocabulary?.name);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [editedName, setEditedName] = useState('');
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

  const fetchVocabulary = async () => {
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
      setVocabulary(vocabularyData);
      setEditedName(vocabularyData.name);

      // Normalize the field inventory (guarantees immutable morphType, tolerates
      // the legacy boolean format).
      setFields(normalizeVocabFields(readVocabFields(vocabularyData.config)));

      setError('');
    } catch (err) {
      if (err.message === 'Not authenticated' || err.status === 401) {
        logout('expired');
        return;
      }
      setError('Failed to load vocabulary');
      console.error('Error fetching vocabulary:', err);
    } finally {
      setLoading(false);
    }
  };

  // Helper function to check permissions
  const canManageVocabulary = (vocab = vocabulary) => {
    if (!user || !vocab) return false;
    return user.isAdmin || vocab.maintainers?.includes(user.id);
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
    comments.onError = (msg, err, label) =>
      notifyError(err ? `${label}: ${humanizeError(err)}` : humanizeError(msg, msg));
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
  const canComment = canManageVocabulary() || writerThroughProject;

  // The tab rides in `?tab=`, so a reload or a shared link reopens the same one.
  // Only the tabs this user actually gets are legal values, so a maintainer's
  // link opened by a reader falls back to the item list instead of selecting a
  // tab that isn't there. A brand new vocabulary shows the create form with no
  // tab bar at all, so its fallback never reaches the URL.
  // Base path for the tab links (the item list is the bare vocabulary URL).
  const vocabPath = `/vocabularies/${vocabularyId}`;
  const [activeTab, setActiveTab] = useTabParam(
    canManageVocabulary()
      ? ['items', 'comments', 'maintainers', 'settings']
      : ['items', 'comments'],
    isNewVocabulary ? 'settings' : 'items',
  );

  // Lightweight update function that only updates vocabulary data without loading state
  const updateVocabulary = async () => {
    if (isNewVocabulary) return;

    try {
      if (!client) {
        throw new Error('Not authenticated');
      }

      if (!vocabularyId || vocabularyId === 'undefined') {
        throw new Error('Invalid vocabulary ID');
      }

      const vocabularyData = await client.vocabLayers.get(vocabularyId);
      setVocabulary(vocabularyData);
      setFields(normalizeVocabFields(readVocabFields(vocabularyData.config)));
    } catch (err) {
      console.error('Error updating vocabulary:', err);
      notifyError('Failed to update vocabulary data', 'Error');
    }
  };

  useEffect(() => {
    fetchVocabulary();
    // Runs once per id; the loader reads the client fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vocabularyId]);

  const handleSave = async () => {
    if (!editedName.trim()) {
      notifyError('Vocabulary name cannot be empty', 'Invalid Name');
      return;
    }
    // Two fast clicks used to run two creates, each reading createdRef before
    // the other resolved, leaving two vocabularies under the one name.
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
            savedVocabulary = await client.vocabLayers.create(name);
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
        notifySuccess('Vocabulary created successfully', 'Success');
      } else {
        // Update existing vocabulary name
        if (editedName !== vocabulary.name) {
          await client.vocabLayers.update(vocabularyId, editedName.trim());
          // Update local state to reflect the change immediately
          await updateVocabulary();
          notifySuccess('Vocabulary name updated successfully', 'Success');
        }
      }

      setIsEditing(false);
    } catch (err) {
      console.error('Error saving vocabulary:', err);
      notifyError('Failed to save vocabulary', 'Error');
    } finally {
      setSaving(false);
    }
  };

  const handleAddField = async () => {
    const trimmedName = newFieldName.trim();
    if (!trimmedName) {
      notifyError('Field name cannot be empty', 'Invalid Field Name');
      return;
    }

    // Check for reserved name
    if (isReservedFieldName(trimmedName)) {
      notifyError(
        `Field name "${trimmedName}" is reserved and cannot be used`,
        'Reserved Field Name',
      );
      return;
    }

    // Check for duplicate names (case insensitive)
    if (fields.some((f) => f.name.toLowerCase() === trimmedName.toLowerCase())) {
      notifyError('A field with this name already exists', 'Duplicate Field Name');
      return;
    }

    await saveFields([...fields, { name: trimmedName, inline: false, immutable: false }]);
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

  // Write the schema and say whether it landed. The table shows the new
  // schema only once the server holds it: shown first, a failed write left
  // the next edit building on a type or tagset the server never had.
  const saveFields = async (updatedFields, { quiet = false } = {}) => {
    try {
      if (!isNewVocabulary) {
        await client.vocabLayers.setConfig(
          vocabularyId,
          IGT_NAMESPACE,
          'fields',
          fieldsToConfig(updatedFields),
        );
        if (!quiet) notifySuccess('Fields updated successfully', 'Success');
      }
      setFields(updatedFields);
      return true;
    } catch (err) {
      console.error('Error saving custom fields:', err);
      notifyError('Failed to save fields', 'Error');
      return false;
    }
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
    const { items = [] } = await client.vocabLayers.get(vocabularyId, true);
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
   */
  const pruneFieldValues = async (fieldName, after, label) => {
    const { items = [] } = await client.vocabLayers.get(vocabularyId, true);
    const live = new Set(items.map((it) => it.id));
    const writes = [];
    for (const it of items) {
      const raw = it.metadata?.[fieldName];
      if (raw == null || raw === '') continue;
      let metadata;
      if (after.type !== FIELD_TYPES.ITEM) {
        metadata = { ...it.metadata };
        delete metadata[fieldName];
      } else {
        const ids = refIds(it, after).filter((x) => x !== it.id && live.has(x));
        metadata = withRefIds(it.metadata, after, ids);
      }
      const now = metadata[fieldName];
      if (JSON.stringify(now ?? null) !== JSON.stringify(raw)) writes.push({ id: it.id, metadata });
    }
    if (!writes.length) return;
    await client.withOperation(`Change "${label}"`, async () => {
      for (let i = 0; i < writes.length; i += FIELD_CLEAR_CHUNK) {
        const chunk = writes.slice(i, i + FIELD_CLEAR_CHUNK);
        await client.batched(async () => {
          for (const w of chunk) {
            if (Object.keys(w.metadata).length) client.vocabItems.setMetadata(w.id, w.metadata);
            else client.vocabItems.deleteMetadata(w.id);
          }
        });
      }
    });
  };

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
      let cost = { cleared: 0, trimmed: 0 };
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
      try {
        await pruneFieldValues(
          fieldName,
          next.find((f) => f.name === fieldName),
          label,
        );
      } catch (err) {
        console.error('Error rewriting entry values after a field type change:', err);
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
  // used the old name in the same operation, or they quietly fall back to
  // free. Same contract as the project's TagsetsSettings.
  const handleSaveTagsets = async (next, meta) => {
    try {
      await client.vocabLayers.setConfig(vocabularyId, IGT_NAMESPACE, 'tagsets', next);
      const renamed = meta?.renamed;
      if (renamed && fields.some((f) => f.tagset === renamed.from)) {
        await saveFields(
          fields.map((f) => (f.tagset === renamed.from ? { ...f, tagset: renamed.to } : f)),
          { quiet: true },
        );
      }
      setDraftTagsets(next);
      await updateVocabulary();
      setDraftTagsets(null);
    } catch (err) {
      console.error('Failed to save tagsets:', err);
      notifyError('Failed to save tagsets', 'Save Error');
      throw err;
    }
  };

  // The [value, count] rows present in the fields this tagset governs, for
  // the seed button. One fetch of the items, only when asked.
  const handleLoadAttested = async (name) => {
    const names = (tagsetUsage[name] || []).map((g) => g.name);
    if (!names.length) return [];
    const { items = [] } = await client.vocabLayers.get(vocabularyId, true);
    const counts = new Map();
    for (const it of items) {
      for (const n of names) {
        const v = it.metadata?.[n];
        if (typeof v !== 'string' || !v) continue;
        counts.set(v, (counts.get(v) || 0) + 1);
      }
    }
    return [...counts.entries()];
  };

  const handleDelete = async () => {
    if (confirmDeleteName !== vocabulary.name) {
      notifyError('The entered name does not match the vocabulary name', 'Name Mismatch');
      return;
    }

    try {
      await client.vocabLayers.delete(vocabularyId);
      closeDeleteModal();
      navigate('/vocabularies');
      notifySuccess('Vocabulary deleted successfully', 'Success');
    } catch (err) {
      console.error('Error deleting vocabulary:', err);
      notifyError('Failed to delete vocabulary', 'Error');
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
              <tr className="bg-muted/50 text-left text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2">Field</th>
                <th className="px-3 py-2">Inline</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Shown on</th>
                <th className="px-3 py-2">Language</th>
                {showTagsetCol && <th className="px-3 py-2">Tagset</th>}
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
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            Required
                          </span>
                        ) : isBuiltInField(field.name) ? (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
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
          <Plus className="h-4 w-4" /> Add Field
        </Button>
      </div>
    </>
  );

  if (loading) {
    return (
      <div className="tw mx-auto max-w-7xl px-4 py-8">
        <div className="flex flex-col items-center gap-4">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-foreground" />
          <p>Loading vocabulary...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="tw mx-auto max-w-7xl px-4 py-8">
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="text-sm">
              <p className="font-medium text-destructive">Error</p>
              <p className="mt-1 text-muted-foreground">{error}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!vocabulary && !isNewVocabulary) {
    return (
      <div className="tw mx-auto max-w-7xl px-4 py-8">
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="text-sm">
              <p className="font-medium text-destructive">Vocabulary Not Found</p>
              <p className="mt-1 text-muted-foreground">
                The requested vocabulary could not be found.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="tw mx-auto max-w-7xl px-4 py-8">
      <div className="flex flex-col gap-6">
        <nav className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link to="/vocabularies" className="text-primary hover:underline">
            Vocabularies
          </Link>
          <span>/</span>
          <span>{isNewVocabulary ? 'New Vocabulary' : vocabulary?.name || 'Loading...'}</span>
        </nav>

        {!isNewVocabulary && (
          <div>
            <h1 className="mb-4 text-2xl font-bold">{vocabulary?.name}</h1>
          </div>
        )}

        {!isNewVocabulary && !isEditing && (
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="tw">
              <TabsTrigger value="items" to={tabTo(vocabPath, 'items', 'items')}>
                <BookText className="h-4 w-4" /> Entries
              </TabsTrigger>
              <TabsTrigger value="comments" to={tabTo(vocabPath, 'comments', 'items')}>
                <MessageSquare className="h-4 w-4" /> Comments
                {(comments?.count ?? 0) > 0 && (
                  <span className="ml-1 rounded-full bg-muted px-1.5 text-[10px] leading-4 tabular-nums">
                    {comments.count}
                  </span>
                )}
              </TabsTrigger>
              {canManageVocabulary() && (
                <TabsTrigger value="maintainers" to={tabTo(vocabPath, 'maintainers', 'items')}>
                  <Users className="h-4 w-4" /> Maintainers
                </TabsTrigger>
              )}
              {canManageVocabulary() && (
                <TabsTrigger value="settings" to={tabTo(vocabPath, 'settings', 'items')}>
                  <Settings className="h-4 w-4" /> Settings
                </TabsTrigger>
              )}
            </TabsList>

            <TabsContent value="items">
              <VocabularyItems
                vocabularyId={vocabularyId}
                vocabulary={vocabulary}
                client={client}
                fields={fields}
                canManage={canManageVocabulary()}
                comments={comments}
                canComment={canComment}
              />
            </TabsContent>

            <TabsContent value="comments">
              <VocabularyCommentsTab
                vocabularyId={vocabularyId}
                client={client}
                store={comments}
                fields={fields}
                canWrite={canComment}
                canDeleteAny={canManageVocabulary()}
              />
            </TabsContent>

            {canManageVocabulary() && (
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

            {canManageVocabulary() && (
              <TabsContent value="settings">
                <div className="flex flex-col gap-6">
                  <div className="rounded-lg border bg-card p-4">
                    <div className="flex flex-col gap-4">
                      <h3 className="text-base font-semibold">Basic Settings</h3>

                      <div className="flex items-end gap-2">
                        <div className="flex flex-1 flex-col gap-1.5">
                          <Label>Vocabulary Name</Label>
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
                          Save Name
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
                        enforceNote="Closed lists apply to what you type here and to Bulk Add. Values brought in by an import or a service are not checked; the item list marks them."
                      />
                    </div>
                  </div>

                  <div className="border-t" />

                  <div className="rounded-lg border border-destructive/40 p-4">
                    <div className="flex flex-col gap-4">
                      <h3 className="text-base font-semibold">Danger Zone</h3>
                      <p className="text-sm text-muted-foreground">
                        Delete this vocabulary permanently. This action cannot be undone.
                      </p>
                      <div>
                        <Button variant="destructive" onClick={openDeleteModal}>
                          <Trash2 className="h-4 w-4" /> Delete Vocabulary
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
            <h2 className="text-lg font-semibold">Create New Vocabulary</h2>

            <div className="rounded-lg border bg-card p-4">
              <div className="flex flex-col gap-1.5">
                <Label>
                  Vocabulary Name <span className="text-destructive">*</span>
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
                Create Vocabulary
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
            <DialogTitle>Delete Vocabulary</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <div className="text-sm">
                  <p className="font-medium text-destructive">Warning</p>
                  <p className="mt-1 text-muted-foreground">
                    You are about to permanently delete the vocabulary{' '}
                    <strong>"{vocabulary?.name}"</strong>.
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    This action cannot be undone and will remove all entries and their links.
                  </p>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>To confirm, type "{vocabulary?.name}" below:</Label>
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
              <Trash2 className="h-4 w-4" /> Delete Vocabulary
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
