import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { Plus, Trash2, ChevronUp, ChevronDown } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { notifySuccess, notifyError, notifyInfo } from '@/utils/feedback';
import { ConfirmDeleteDialog } from '@/components/shared/ConfirmDeleteDialog';

// A field's identity is its (scope, name) pair: the same name can exist at
// two scopes (a FieldWorks import gives "Gloss" and "POS" at both Word and
// Morpheme scope, and so do the defaults below), so nothing here may key on
// the name alone.
export const fieldKey = (f) => `${f.scope}:${f.name}`;

// Radix Select has no empty-string item value, so "no tagset" needs a sentinel.
const NO_TAGSET = '__none__';

// Default annotation fields: the set a FieldWorks import produces (see
// import/flex/importEngine.js deriveImportConfig). Keep in sync with the
// setup wizard's seed in setup/FieldsStep.jsx.
const DEFAULT_FIELDS = [
  { name: 'Gloss', scope: 'Word', isCustom: false },
  { name: 'POS', scope: 'Word', isCustom: false },
  { name: 'Gloss', scope: 'Morpheme', isCustom: false },
  { name: 'POS', scope: 'Morpheme', isCustom: false },
  { name: 'Translation', scope: 'Sentence', isCustom: false },
  { name: 'Literal Translation', scope: 'Sentence', isCustom: false },
  { name: 'Note', scope: 'Sentence', isCustom: false },
];

// The letter-like exceptions are single CHARACTERS (see domain/igtConfig.js),
// so these read one comma-separated field two ways: what will be saved, and
// what was typed but cannot be a character.
const exceptionChars = (text) => splitEntries(text).filter((e) => [...e].length === 1);
const rejectedEntries = (text) => splitEntries(text).filter((e) => [...e].length !== 1);
const splitEntries = (text) =>
  String(text ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
const sameChars = (a, b) => a.length === b.length && a.every((c, i) => c === b[i]);

// Default ignored tokens configuration
const DEFAULT_IGNORED_TOKENS = {
  mode: 'unicode-punctuation',
  unicodePunctuationExceptions: [],
  explicitIgnoredTokens: [],
};

export const FieldsManager = ({
  initialData,
  onLoadData,
  onSaveChanges,
  onError,
  // Async (field) => number|null of existing annotations in the field's span
  // layer. When provided (settings mode), deletion asks for confirmation with
  // the count; when absent (setup mode — no layers exist yet), deletion is
  // immediate.
  onCountFieldUsage,
  // Async (field, 'up'|'down'). When provided (settings mode) the server owns
  // the order and a move is a shift of the field's span layer; the table then
  // re-syncs from the project. When absent (setup mode) the list order is the
  // creation order and the move is local.
  onMoveField,
  // Names of the project's tagsets, for the per-field Tagset picker. Empty in
  // setup mode (tagsets are configured in settings, after the fields exist).
  tagsetNames = [],
  // "scope:field" -> how many of the field's values its tagset refuses. The
  // count is a link into the Validation tab, which is where you can see and fix
  // them; a field with no tagset, or no violations, gets nothing.
  violations = {},
  projectId,
  showTitle = true,
}) => {
  const [fields, setFields] = useState([]);
  const [ignoredTokens, setIgnoredTokens] = useState(DEFAULT_IGNORED_TOKENS);
  const [newFieldName, setNewFieldName] = useState('');
  const [newFieldScope, setNewFieldScope] = useState('Word');
  const [hoveredField, setHoveredField] = useState(null);
  const [isInitialized, setIsInitialized] = useState(false);
  // { name, count } — count: undefined while counting, null if unknown.
  const [pendingDelete, setPendingDelete] = useState(null);
  // The letter-like characters as TYPED, so a two-character entry can be
  // corrected where it stands rather than vanishing on the next keystroke.
  // `rejectedExceptions` are the entries that were not saved. The ref lets the
  // reload effect below see the current text without re-running on every
  // keystroke.
  const [exceptionsText, setExceptionsText] = useState('');
  const [rejectedExceptions, setRejectedExceptions] = useState([]);
  const exceptionsTextRef = useRef('');
  const writeExceptionsText = (text) => {
    exceptionsTextRef.current = text;
    setExceptionsText(text);
  };

  // Define scope options (morpheme layer is always present)
  const scopeOptions = [
    { value: 'Word', label: 'Word' },
    { value: 'Morpheme', label: 'Morpheme' },
    { value: 'Sentence', label: 'Sentence' },
  ];

  // Initialize data on mount
  useEffect(() => {
    const initializeData = async () => {
      try {
        let fieldsData = initialData;

        // If no initial data provided, try loading from callback
        if (!fieldsData && onLoadData) {
          fieldsData = await onLoadData();
        }

        // If still no data, use defaults
        if (!fieldsData?.fields) {
          fieldsData = {
            fields: DEFAULT_FIELDS,
            ignoredTokens: DEFAULT_IGNORED_TOKENS,
          };
        }

        const loadedIgnored = fieldsData.ignoredTokens || DEFAULT_IGNORED_TOKENS;
        setFields(fieldsData.fields);
        setIgnoredTokens(loadedIgnored);
        // This effect re-runs on every save, because the parent hands down a
        // fresh project. Adopting the stored list unconditionally would wipe
        // the field mid-edit: typing "-ab" saves nothing, the reload arrives,
        // and the two characters already typed disappear before a third can
        // be. Adopt it only when it says something the field does not already
        // say — a change made elsewhere, or the first load.
        const incoming = loadedIgnored.unicodePunctuationExceptions || [];
        if (!sameChars(incoming, exceptionChars(exceptionsTextRef.current))) {
          writeExceptionsText(incoming.join(', '));
        }
        setIsInitialized(true);
      } catch (error) {
        console.error('Failed to load fields configuration:', error);
        // Still set as initialized even on error, so we show the default fields
        setFields(DEFAULT_FIELDS);
        setIgnoredTokens(DEFAULT_IGNORED_TOKENS);
        writeExceptionsText('');
        setIsInitialized(true);

        if (onError) {
          onError(error);
        } else {
          notifyError('Failed to load fields configuration', 'Load Error');
        }
      }
    };

    initializeData();
  }, [initialData]);

  const saveChanges = async (newFields, newIgnoredTokens) => {
    try {
      if (onSaveChanges) {
        await onSaveChanges({
          fields: newFields,
          ignoredTokens: newIgnoredTokens,
        });
      }
      setFields(newFields);
      setIgnoredTokens(newIgnoredTokens);
    } catch (error) {
      console.error('Failed to save fields configuration:', error);
      if (onError) {
        onError(error);
      } else {
        notifyError('Failed to save fields configuration', 'Save Error');
      }
    }
  };

  const handleAddField = async () => {
    const trimmedName = newFieldName.trim();

    if (!trimmedName) {
      notifyError('Field name cannot be empty', 'Invalid Field Name');
      return;
    }

    // Check for duplicate names at the SAME scope (case insensitive)
    const isDuplicate = fields.some(
      (field) =>
        field.scope === newFieldScope && field.name.toLowerCase() === trimmedName.toLowerCase(),
    );

    if (isDuplicate) {
      notifyError(`A ${newFieldScope} field with this name already exists`, 'Duplicate Field');
      return;
    }

    const newField = {
      name: trimmedName,
      scope: newFieldScope,
      isCustom: true,
      tagset: null,
    };

    const updatedFields = [...fields, newField];
    await saveChanges(updatedFields, ignoredTokens);

    setNewFieldName('');
    setNewFieldScope('Word');
    notifySuccess(`"${trimmedName}" has been added with ${newFieldScope} scope`, 'Field Added');
  };

  const handleDeleteField = async (key) => {
    const field = fields.find((f) => fieldKey(f) === key);
    const updatedFields = fields.filter((f) => fieldKey(f) !== key);
    await saveChanges(updatedFields, ignoredTokens);

    notifyInfo(`"${field?.name ?? key}" has been removed`, 'Field Removed');
  };

  // Point a field at a tagset (or at none). The reference is by name, so this
  // stores a string rather than a copy of the list.
  const handleSetTagset = async (key, choice) => {
    const tagset = choice === NO_TAGSET ? null : choice;
    const updated = fields.map((f) => (fieldKey(f) === key ? { ...f, tagset } : f));
    await saveChanges(updated, ignoredTokens);
  };

  // Entry point for the trash button: in settings mode open the confirm
  // dialog right away and fill in the annotation count as it resolves.
  const requestDeleteField = (key) => {
    if (!onCountFieldUsage) {
      handleDeleteField(key);
      return;
    }
    const field = fields.find((f) => fieldKey(f) === key);
    const base = { key, name: field?.name ?? key, scope: field?.scope };
    setPendingDelete({ ...base, count: undefined });
    Promise.resolve(onCountFieldUsage(field))
      .then((n) => setPendingDelete((p) => (p?.key === key ? { ...base, count: n } : p)))
      .catch(() => setPendingDelete((p) => (p?.key === key ? { ...base, count: null } : p)));
  };

  const handleConfirmDelete = async () => {
    const key = pendingDelete?.key;
    setPendingDelete(null);
    if (key) await handleDeleteField(key);
  };

  // A field only ever moves among the fields of its own scope: the grid shows
  // each scope's fields as a group, so crossing into another scope's rows
  // would reorder nothing on screen.
  const neighborInScope = (key, direction) => {
    const i = fields.findIndex((field) => fieldKey(field) === key);
    if (i === -1) return -1;
    const j = direction === 'up' ? i - 1 : i + 1;
    return j >= 0 && j < fields.length && fields[j].scope === fields[i].scope ? j : -1;
  };

  const handleMoveField = async (key, direction) => {
    const currentIndex = fields.findIndex((field) => fieldKey(field) === key);
    const newIndex = neighborInScope(key, direction);
    if (currentIndex === -1 || newIndex === -1) return;

    if (onMoveField) {
      try {
        await onMoveField(fields[currentIndex], direction);
      } catch (error) {
        console.error('Failed to move field:', error);
        if (onError) onError(error);
        else notifyError('Failed to move the field', 'Save Error');
      }
      return;
    }

    const newFields = [...fields];
    const [movedField] = newFields.splice(currentIndex, 1);
    newFields.splice(newIndex, 0, movedField);

    await saveChanges(newFields, ignoredTokens);
  };

  const handleKeyPress = (event) => {
    if (event.key === 'Enter') {
      handleAddField();
    }
  };

  // Would the new field collide with one at the SAME scope? Name alone is not
  // a collision: Gloss and POS exist at both Word and Morpheme scope by
  // default, and this used to stop a project without a Word-scope Gloss from
  // ever adding one.
  const wouldBeDuplicate = () => {
    const trimmedName = newFieldName.trim();
    if (!trimmedName) return false;
    return fields.some(
      (field) =>
        field.scope === newFieldScope && field.name.toLowerCase() === trimmedName.toLowerCase(),
    );
  };

  const handleIgnoredTokensModeChange = async (mode) => {
    const updatedIgnoredTokens = {
      ...ignoredTokens,
      mode,
    };
    await saveChanges(fields, updatedIgnoredTokens);
  };

  // The list is single CHARACTERS, each of which behaves as a letter (see
  // domain/igtConfig.js). A longer entry cannot: nothing ever compares a whole
  // string against a character, so it would sit in the config doing nothing —
  // which is what "-ab" was doing in a real project. The field keeps what was
  // typed so an entry can be corrected in place, saves the characters, and
  // names what it would not take.
  const handleExceptionsChange = async (text) => {
    writeExceptionsText(text);
    const chars = exceptionChars(text);
    setRejectedExceptions(rejectedEntries(text));
    if (sameChars(chars, ignoredTokens.unicodePunctuationExceptions || [])) return;
    await saveChanges(fields, { ...ignoredTokens, unicodePunctuationExceptions: chars });
  };

  const handleExplicitTokensChange = async (tokens) => {
    const updatedIgnoredTokens = {
      ...ignoredTokens,
      explicitIgnoredTokens: tokens,
    };
    await saveChanges(fields, updatedIgnoredTokens);
  };

  // Parse a comma-separated string into a trimmed, non-empty array of tags
  const parseTags = (value) =>
    value
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);

  // Don't render until initialized
  if (!isInitialized) {
    return (
      <div className="rounded-lg border p-4 text-sm text-muted-foreground">
        Loading fields configuration...
      </div>
    );
  }

  // Prepare data for the table
  const tableData = fields.map((field, index) => ({
    ...field,
    id: `${fieldKey(field)}-${index}`, // Unique ID for table
    key: fieldKey(field),
  }));

  // Color classes for scope badges (Word=blue, Morpheme=teal, Sentence=green)
  const scopeBadgeClasses = {
    Word: 'border-transparent bg-blue-100 text-blue-700',
    Morpheme: 'border-transparent bg-teal-100 text-teal-700',
    Sentence: 'border-transparent bg-green-100 text-green-700',
  };

  return (
    <div className="flex flex-col gap-8">
      {/* Annotation Fields Section. In setup (showTitle) the step supplies the
          lead-in text; embedded in settings the section carries its own
          title + description. */}
      <div>
        {showTitle ? (
          <p className="mb-4 text-sm font-medium">Annotation Fields</p>
        ) : (
          <>
            <h2 className="text-lg font-semibold">Annotation Fields</h2>
            <p className="mb-4 mt-1 text-sm text-muted-foreground">
              Configure annotation fields for your project. Word scope fields apply to words,
              Morpheme scope fields apply to morphemes, and Sentence scope fields apply to entire
              sentences.
            </p>
          </>
        )}

        {/* Fields table */}
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="w-[15%] px-3 py-2 text-left font-medium">Scope</th>
                <th className="px-3 py-2 text-left font-medium">Field Name</th>
                {tagsetNames.length > 0 && (
                  <th className="w-[22%] px-3 py-2 text-left font-medium">Tagset</th>
                )}
                <th className="w-px px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {tableData.map((record, index) => (
                <tr
                  key={record.id}
                  className="group hover:bg-muted/50"
                  onMouseEnter={() => setHoveredField(record.key)}
                  onMouseLeave={() => setHoveredField(null)}
                >
                  <td className="border-t px-3 py-2 align-middle">
                    <Badge variant="secondary" className={scopeBadgeClasses[record.scope]}>
                      {record.scope}
                    </Badge>
                  </td>
                  <td className="border-t px-3 py-2 align-middle">
                    {record.name}
                    {violations[`${record.scope.toLowerCase()}:${record.name}`] > 0 && (
                      <Link
                        to={`/projects/${projectId}?tab=validate`}
                        className="ml-2 inline-flex items-center gap-1 rounded bg-destructive/10 px-1.5 py-0.5 align-middle text-xs text-destructive hover:underline"
                        title="Show these in the Validation tab"
                      >
                        <AlertTriangle className="h-3 w-3" />
                        {violations[`${record.scope.toLowerCase()}:${record.name}`]} outside the
                        tagset
                      </Link>
                    )}
                  </td>
                  {tagsetNames.length > 0 && (
                    <td className="border-t px-3 py-2 align-middle">
                      <Select
                        value={record.tagset ?? NO_TAGSET}
                        onValueChange={(v) => handleSetTagset(record.key, v)}
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NO_TAGSET}>No tagset</SelectItem>
                          {tagsetNames.map((n) => (
                            <SelectItem key={n} value={n}>
                              {n}
                            </SelectItem>
                          ))}
                          {/* A field can point at a tagset that has since been
                              renamed or deleted. Keep the dangling name
                              selectable so the picker shows what is actually
                              stored rather than silently reading as "none". */}
                          {record.tagset && !tagsetNames.includes(record.tagset) && (
                            <SelectItem value={record.tagset}>{record.tagset} (missing)</SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                    </td>
                  )}
                  <td className="w-px whitespace-nowrap border-t px-3 py-2 align-middle">
                    <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleMoveField(record.key, 'up');
                        }}
                        disabled={neighborInScope(record.key, 'up') === -1}
                        title="Move up"
                      >
                        <ChevronUp className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleMoveField(record.key, 'down');
                        }}
                        disabled={neighborInScope(record.key, 'down') === -1}
                        title="Move down"
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        onClick={(event) => {
                          event.stopPropagation();
                          requestDeleteField(record.key);
                        }}
                        title="Remove"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Add Field Form */}
        <div className="mt-4 flex flex-col gap-4">
          <p className="text-sm font-medium">Add Field</p>
          <div className="flex items-center gap-2">
            <Input
              placeholder="Enter field name"
              value={newFieldName}
              onChange={(event) => setNewFieldName(event.currentTarget.value)}
              onKeyDown={handleKeyPress}
              className="flex-1"
            />
            <Select value={newFieldScope} onValueChange={setNewFieldScope}>
              <SelectTrigger className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {scopeOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={handleAddField} disabled={!newFieldName.trim() || wouldBeDuplicate()}>
              <Plus className="h-4 w-4" /> Add Field
            </Button>
          </div>
        </div>
      </div>

      {/* Ignored Tokens Section, separated from Annotation Fields by a rule. */}
      <div className="border-t pt-6">
        <p className={showTitle ? 'mb-4 text-sm font-medium' : 'mb-1 text-lg font-semibold'}>
          Ignored Tokens
        </p>
        <div className="mb-6 text-sm text-muted-foreground">
          Which tokens carry no{' '}
          <Badge variant="secondary" className={scopeBadgeClasses['Word']}>
            Word
          </Badge>{' '}
          scope annotations, and where the built-in tokenizer splits words.
        </div>

        <div className="flex flex-col gap-6">
          <label className="flex items-start gap-3">
            <input
              type="radio"
              name="ignored-tokens-mode"
              value="unicode-punctuation"
              checked={ignoredTokens.mode === 'unicode-punctuation'}
              onChange={() => handleIgnoredTokensModeChange('unicode-punctuation')}
              className="mt-1"
            />
            <span>
              <span className="text-sm font-medium">Unicode Punctuation (Recommended)</span>
              <span className="block text-xs text-muted-foreground">
                Automatically ignore all Unicode punctuation characters (category 'P')
              </span>
            </span>
          </label>

          {ignoredTokens.mode === 'unicode-punctuation' && (
            <div className="ml-8 rounded-md border p-4">
              <p className="mb-1 text-sm font-medium">Characters that behave as letters</p>
              <div className="mb-4 text-xs text-muted-foreground">
                Typed between letters, these join the word instead of splitting it. They stay on the
                word's form in the lexicon, and a token spelled with them takes{' '}
                <Badge variant="secondary" className={scopeBadgeClasses['Word']}>
                  Word
                </Badge>{' '}
                scope annotations.
              </div>
              <Input
                placeholder={"Separate with commas (e.g. ʼ, ', -)"}
                value={exceptionsText}
                onChange={(event) => handleExceptionsChange(event.currentTarget.value)}
              />
              {rejectedExceptions.length > 0 && (
                <p className="mt-2 text-xs text-destructive">
                  One character each. Not saved: {rejectedExceptions.join(', ')}
                </p>
              )}
            </div>
          )}

          <label className="flex items-start gap-3">
            <input
              type="radio"
              name="ignored-tokens-mode"
              value="explicit-list"
              checked={ignoredTokens.mode === 'explicit-list'}
              onChange={() => handleIgnoredTokensModeChange('explicit-list')}
              className="mt-1"
            />
            <span>
              <span className="text-sm font-medium">Explicit List</span>
              <span className="block text-xs text-muted-foreground">
                Manually specify which tokens to ignore
              </span>
            </span>
          </label>

          {ignoredTokens.mode === 'explicit-list' && (
            <div className="ml-8 rounded-md border p-4">
              <p className="mb-1 text-sm font-medium">Ignored Tokens</p>
              <div className="mb-4 text-xs text-muted-foreground">
                These specific tokens will be ignored for{' '}
                <Badge variant="secondary" className={scopeBadgeClasses['Word']}>
                  Word
                </Badge>{' '}
                scope annotations:
              </div>
              <Input
                placeholder="Add tokens to ignore (e.g. . , ; !)"
                value={(ignoredTokens.explicitIgnoredTokens || []).join(', ')}
                onChange={(event) =>
                  handleExplicitTokensChange(parseTags(event.currentTarget.value))
                }
              />
            </div>
          )}
        </div>
      </div>

      {/* Field-deletion confirmation (settings mode only). Deleting a field
          deletes its span layer and every annotation in it, project-wide. */}
      <ConfirmDeleteDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => {
          if (!o) setPendingDelete(null);
        }}
        title="Delete Annotation Field"
        confirmLabel="Delete Field"
        confirmDisabled={pendingDelete?.count === undefined}
        onConfirm={handleConfirmDelete}
      >
        <p className="font-medium text-destructive">Warning</p>
        <p className="mt-1 text-muted-foreground">
          You are about to permanently delete the field <strong>"{pendingDelete?.name}"</strong> and
          all of its annotations across every document in this project.
        </p>
        <p className="mt-1 text-muted-foreground">
          {pendingDelete?.count === undefined && 'Counting existing annotations…'}
          {pendingDelete?.count === null &&
            'The number of existing annotations could not be determined. The field may still contain data.'}
          {typeof pendingDelete?.count === 'number' &&
            (pendingDelete.count === 0 ? (
              'This field has no annotations yet.'
            ) : (
              <>
                This field currently has{' '}
                <strong>
                  {pendingDelete.count.toLocaleString()} annotation
                  {pendingDelete.count === 1 ? '' : 's'}
                </strong>
                . This cannot be undone.
              </>
            ))}
        </p>
      </ConfirmDeleteDialog>
    </div>
  );
};
