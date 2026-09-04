import { useState, useEffect, useMemo } from 'react';
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
  humanizeFieldName,
  vocabGovernedFields,
} from '@/domain/vocabFields';
import { readTagsets, byTagsetName } from '@/domain/tagsets';
import { TagsetsManager } from '@/components/projects/settings/TagsetsManager.jsx';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { VocabularyItems } from './VocabularyItems';
import { VocabularyMaintainers } from './VocabularyMaintainers';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useTabParam, tabTo } from '@/hooks/useTabParam';

// Radix Select has no empty-string item value, so "no tagset" needs a sentinel.
const NO_TAGSET = '__none__';

export const VocabularyDetail = () => {
  const { vocabularyId } = useParams();
  const navigate = useNavigate();
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
      // Seed a new vocab with the full core inventory.
      setFields(normalizeVocabFields(seedDefaultFields()));
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

  // The tab rides in `?tab=`, so a reload or a shared link reopens the same one.
  // Only the tabs this user actually gets are legal values, so a maintainer's
  // link opened by a reader falls back to the item list instead of selecting a
  // tab that isn't there. A brand new vocabulary shows the create form with no
  // tab bar at all, so its fallback never reaches the URL.
  // Base path for the tab links (the item list is the bare vocabulary URL).
  const vocabPath = `/vocabularies/${vocabularyId}`;
  const [activeTab, setActiveTab] = useTabParam(
    canManageVocabulary() ? ['items', 'maintainers', 'settings'] : ['items'],
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
  }, [vocabularyId]);

  const handleSave = async () => {
    if (!editedName.trim()) {
      notifyError('Vocabulary name cannot be empty', 'Invalid Name');
      return;
    }

    try {
      let savedVocabulary;

      if (isNewVocabulary) {
        savedVocabulary = await client.vocabLayers.create(editedName.trim());

        // Persist the field inventory (always non-empty — morphType is core).
        await client.vocabLayers.setConfig(
          savedVocabulary.id,
          IGT_NAMESPACE,
          'fields',
          fieldsToConfig(fields),
        );

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
    }
  };

  const handleAddField = async () => {
    const trimmedName = newFieldName.trim();
    if (!trimmedName) {
      notifyError('Field name cannot be empty', 'Invalid Field Name');
      return;
    }

    // Check for reserved name
    if (trimmedName.toLowerCase() === 'form') {
      notifyError('Field name "form" is reserved and cannot be used', 'Reserved Field Name');
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

  const saveFields = async (updatedFields, { quiet = false } = {}) => {
    try {
      setFields(updatedFields);

      // Save to server if not a new vocabulary
      if (!isNewVocabulary) {
        await client.vocabLayers.setConfig(
          vocabularyId,
          IGT_NAMESPACE,
          'fields',
          fieldsToConfig(updatedFields),
        );
        if (!quiet) notifySuccess('Fields updated successfully', 'Success');
      }
    } catch (err) {
      console.error('Error saving custom fields:', err);
      notifyError('Failed to save fields', 'Error');
    }
  };

  // Point a field at one of the vocabulary's tagsets (or at none). By name,
  // like a project field, so the list is stored once.
  const handleSetTagset = async (fieldName, choice) => {
    const tagset = choice === NO_TAGSET ? null : choice;
    await saveFields(fields.map((f) => (f.name === fieldName ? { ...f, tagset } : f)));
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

  const renderCustomFieldsEditor = () => (
    <>
      {fields.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {fields.map((field, idx) => {
            const canMoveUp = idx > 0 && !field.immutable && !fields[idx - 1].immutable;
            const canMoveDown = idx < fields.length - 1 && !field.immutable;
            return (
              <div
                key={field.name}
                className="group flex items-center justify-between rounded-md px-1 py-1 hover:bg-muted/40"
              >
                <div className="flex items-center gap-3">
                  <span className="text-sm">{humanizeFieldName(field.name)}</span>
                  {field.immutable && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      Required
                    </span>
                  )}
                  <div className="flex items-center gap-2">
                    <Label
                      htmlFor={`inline-${field.name}`}
                      className="text-xs text-muted-foreground"
                    >
                      Show inline
                    </Label>
                    <Switch
                      id={`inline-${field.name}`}
                      checked={field.inline}
                      onCheckedChange={() => handleToggleInline(field.name)}
                    />
                  </div>
                  {/* Morph type is its own fixed list, so it never takes a
                      tagset. Everything else can, once the vocabulary has one
                      (or already points at one that was since removed). */}
                  {!isNewVocabulary &&
                    field.name !== 'morphType' &&
                    (tagsetNames.length > 0 || field.tagset) && (
                      <div className="flex items-center gap-2">
                        <Label
                          htmlFor={`tagset-${field.name}`}
                          className="text-xs text-muted-foreground"
                        >
                          Tagset
                        </Label>
                        <Select
                          value={field.tagset ?? NO_TAGSET}
                          onValueChange={(v) => handleSetTagset(field.name, v)}
                        >
                          <SelectTrigger id={`tagset-${field.name}`} className="h-7 w-40 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NO_TAGSET}>No tagset</SelectItem>
                            {tagsetNames.map((n) => (
                              <SelectItem key={n} value={n}>
                                {n}
                              </SelectItem>
                            ))}
                            {/* A dangling name stays selectable so the picker
                                shows what is stored rather than reading as
                                "none" and overwriting it. */}
                            {field.tagset && !tagsetNames.includes(field.tagset) && (
                              <SelectItem value={field.tagset}>{field.tagset} (missing)</SelectItem>
                            )}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                </div>
                <div className="flex items-center gap-0.5 text-muted-foreground">
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
                  {!field.immutable && (
                    <button
                      type="button"
                      aria-label={`Remove ${humanizeFieldName(field.name)}`}
                      onClick={() => handleRemoveField(field.name)}
                      className="rounded p-1 hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Input
          placeholder="Enter field name"
          value={newFieldName}
          onChange={(event) => setNewFieldName(event.target.value)}
          className="flex-1"
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
      <div className="tw mx-auto max-w-5xl px-4 py-8">
        <div className="flex flex-col items-center gap-4">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-foreground" />
          <p>Loading vocabulary...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="tw mx-auto max-w-5xl px-4 py-8">
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
      <div className="tw mx-auto max-w-5xl px-4 py-8">
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
    <div className="tw mx-auto max-w-5xl px-4 py-8">
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
                <BookText className="h-4 w-4" /> Vocabulary Items
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
                        Fields on every vocabulary item. Field names cannot be "form" or duplicate
                        existing fields (case-insensitive). Fields set to{' '}
                        <strong>Show inline</strong> also appear in the interlinear view. A field
                        can be held to a tagset, defined below.
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
                  Fields on every vocabulary item. Field names cannot be "form" or duplicate
                  existing fields (case-insensitive).
                </p>

                {renderCustomFieldsEditor()}
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => navigate('/vocabularies')}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={!editedName.trim()}>
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
                    This action cannot be undone and will remove all vocabulary items and their
                    links.
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
