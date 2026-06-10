import { useState, useEffect } from 'react';
import { Plus, Trash2, ChevronUp, ChevronDown } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem
} from '@/components/ui/select';
import { notifySuccess, notifyError, notifyInfo } from '@/utils/feedback';
import { ConfirmDeleteDialog } from '@/components/shared/ConfirmDeleteDialog';

// Default annotation fields
const DEFAULT_FIELDS = [
  {
    name: 'Gloss',
    scope: 'Word',
    isCustom: false
  },
  {
    name: 'Translation',
    scope: 'Sentence',
    isCustom: false
  }
];

// Default ignored tokens configuration
const DEFAULT_IGNORED_TOKENS = {
  mode: 'unicode-punctuation',
  unicodePunctuationExceptions: [],
  explicitIgnoredTokens: []
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
  showTitle = true
}) => {
  const [fields, setFields] = useState([]);
  const [ignoredTokens, setIgnoredTokens] = useState(DEFAULT_IGNORED_TOKENS);
  const [newFieldName, setNewFieldName] = useState('');
  const [newFieldScope, setNewFieldScope] = useState('Word');
  const [hoveredField, setHoveredField] = useState(null);
  const [isInitialized, setIsInitialized] = useState(false);
  // { name, count } — count: undefined while counting, null if unknown.
  const [pendingDelete, setPendingDelete] = useState(null);

  // Define scope options (morpheme layer is always present)
  const scopeOptions = [
    { value: 'Word', label: 'Word' },
    { value: 'Morpheme', label: 'Morpheme' },
    { value: 'Sentence', label: 'Sentence' }
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
            ignoredTokens: DEFAULT_IGNORED_TOKENS
          };
        }

        setFields(fieldsData.fields);
        setIgnoredTokens(fieldsData.ignoredTokens || DEFAULT_IGNORED_TOKENS);
        setIsInitialized(true);
      } catch (error) {
        console.error('Failed to load fields configuration:', error);
        // Still set as initialized even on error, so we show the default fields
        setFields(DEFAULT_FIELDS);
        setIgnoredTokens(DEFAULT_IGNORED_TOKENS);
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
          ignoredTokens: newIgnoredTokens
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

    // Check for duplicate names (case insensitive)
    const isDuplicate = fields.some(field =>
      field.name.toLowerCase() === trimmedName.toLowerCase()
    );

    if (isDuplicate) {
      notifyError('A field with this name already exists', 'Duplicate Field');
      return;
    }

    const newField = {
      name: trimmedName,
      scope: newFieldScope,
      isCustom: true
    };

    const updatedFields = [...fields, newField];
    await saveChanges(updatedFields, ignoredTokens);

    setNewFieldName('');
    setNewFieldScope('Word');
    notifySuccess(`"${trimmedName}" has been added with ${newFieldScope} scope`, 'Field Added');
  };

  const handleDeleteField = async (fieldName) => {
    const updatedFields = fields.filter(field => field.name !== fieldName);
    await saveChanges(updatedFields, ignoredTokens);

    notifyInfo(`"${fieldName}" has been removed`, 'Field Removed');
  };

  // Entry point for the trash button: in settings mode open the confirm
  // dialog right away and fill in the annotation count as it resolves.
  const requestDeleteField = (fieldName) => {
    if (!onCountFieldUsage) {
      handleDeleteField(fieldName);
      return;
    }
    setPendingDelete({ name: fieldName, count: undefined });
    const field = fields.find(f => f.name === fieldName);
    Promise.resolve(onCountFieldUsage(field))
      .then(n => setPendingDelete(p => (p?.name === fieldName ? { name: fieldName, count: n } : p)))
      .catch(() => setPendingDelete(p => (p?.name === fieldName ? { name: fieldName, count: null } : p)));
  };

  const handleConfirmDelete = async () => {
    const fieldName = pendingDelete?.name;
    setPendingDelete(null);
    if (fieldName) await handleDeleteField(fieldName);
  };

  const handleMoveField = async (fieldName, direction) => {
    const currentIndex = fields.findIndex(field => field.name === fieldName);
    if (currentIndex === -1) return;

    const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (newIndex < 0 || newIndex >= fields.length) return;

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

  // Check if new field name would be a duplicate
  const wouldBeDuplicate = () => {
    const trimmedName = newFieldName.trim();
    if (!trimmedName) return false;
    return fields.some(field =>
      field.name.toLowerCase() === trimmedName.toLowerCase()
    );
  };

  const handleIgnoredTokensModeChange = async (mode) => {
    const updatedIgnoredTokens = {
      ...ignoredTokens,
      mode
    };
    await saveChanges(fields, updatedIgnoredTokens);
  };

  const handleExceptionsChange = async (exceptions) => {
    const updatedIgnoredTokens = {
      ...ignoredTokens,
      unicodePunctuationExceptions: exceptions
    };
    await saveChanges(fields, updatedIgnoredTokens);
  };

  const handleExplicitTokensChange = async (tokens) => {
    const updatedIgnoredTokens = {
      ...ignoredTokens,
      explicitIgnoredTokens: tokens
    };
    await saveChanges(fields, updatedIgnoredTokens);
  };

  // Parse a comma-separated string into a trimmed, non-empty array of tags
  const parseTags = (value) =>
    value
      .split(',')
      .map(tag => tag.trim())
      .filter(tag => tag.length > 0);

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
    id: `${field.name}-${index}` // Unique ID for table
  }));

  // Color classes for scope badges (Word=blue, Morpheme=violet, Sentence=green)
  const scopeBadgeClasses = {
    'Word': 'border-transparent bg-blue-100 text-blue-700',
    'Morpheme': 'border-transparent bg-violet-100 text-violet-700',
    'Sentence': 'border-transparent bg-green-100 text-green-700'
  };

  return (
    <div className="flex flex-col gap-8">
      {/* Annotation Fields Section — its own card. In setup (showTitle) the step
          supplies the lead-in text; embedded in settings the card carries its own
          title + description. */}
      <div className="rounded-lg border bg-card p-4">
        {showTitle ? (
          <p className="mb-4 text-sm font-medium">Annotation Fields</p>
        ) : (
          <>
            <p className="text-lg font-medium">Annotation Fields</p>
            <p className="mb-4 mt-1 text-sm text-muted-foreground">
              Configure annotation fields for your project. Word scope fields apply to words,
              Morpheme scope fields apply to morphemes, and Sentence scope fields apply to entire sentences.
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
              </tr>
            </thead>
            <tbody>
              {tableData.map((record, index) => (
                <tr
                  key={record.id}
                  className="group hover:bg-muted/50"
                  onMouseEnter={() => setHoveredField(record.name)}
                  onMouseLeave={() => setHoveredField(null)}
                >
                  <td className="border-t px-3 py-2 align-middle">
                    <Badge
                      variant="secondary"
                      className={scopeBadgeClasses[record.scope]}
                    >
                      {record.scope}
                    </Badge>
                  </td>
                  <td className="border-t px-3 py-2 align-middle">
                    <div className="flex items-center justify-between gap-2">
                      <span>{record.name}</span>
                      <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleMoveField(record.name, 'up');
                          }}
                          disabled={tableData.findIndex(item => item.name === record.name) === 0}
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
                            handleMoveField(record.name, 'down');
                          }}
                          disabled={tableData.findIndex(item => item.name === record.name) === tableData.length - 1}
                          title="Move down"
                        >
                          <ChevronDown className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-destructive hover:text-destructive"
                          onClick={(event) => {
                            event.stopPropagation();
                            requestDeleteField(record.name);
                          }}
                          title="Remove"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
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
                {scopeOptions.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              onClick={handleAddField}
              disabled={!newFieldName.trim() || wouldBeDuplicate()}
            >
              <Plus className="h-4 w-4" /> Add Field
            </Button>
          </div>
        </div>
      </div>

      {/* Ignored Tokens Section — its own card, separated from Annotation Fields
          by the outer gap-8. */}
      <div className="rounded-lg border bg-card p-4">
        <p className={showTitle ? 'mb-4 text-sm font-medium' : 'mb-1 text-lg font-medium'}>Ignored Tokens</p>
        <div className="mb-6 text-sm text-muted-foreground">
          Configure which tokens should be ignored when applying{' '}
          <Badge variant="secondary" className={scopeBadgeClasses['Word']}>Word</Badge> scope annotations.
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
              <p className="mb-1 text-sm font-medium">
                Punctuation Exceptions
              </p>
              <div className="mb-4 text-xs text-muted-foreground">
                These punctuation marks will NOT be ignored and can receive{' '}
                <Badge variant="secondary" className={scopeBadgeClasses['Word']}>Word</Badge> scope annotations:
              </div>
              <Input
                placeholder={"Add punctuation to include (e.g. ', \", -)"}
                value={(ignoredTokens.unicodePunctuationExceptions || []).join(', ')}
                onChange={(event) => handleExceptionsChange(parseTags(event.currentTarget.value))}
              />
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
              <p className="mb-1 text-sm font-medium">
                Ignored Tokens
              </p>
              <div className="mb-4 text-xs text-muted-foreground">
                These specific tokens will be ignored for{' '}
                <Badge variant="secondary" className={scopeBadgeClasses['Word']}>Word</Badge> scope annotations:
              </div>
              <Input
                placeholder="Add tokens to ignore (e.g. . , ; !)"
                value={(ignoredTokens.explicitIgnoredTokens || []).join(', ')}
                onChange={(event) => handleExplicitTokensChange(parseTags(event.currentTarget.value))}
              />
            </div>
          )}
        </div>
      </div>

      {/* Field-deletion confirmation (settings mode only). Deleting a field
          deletes its span layer and every annotation in it, project-wide. */}
      <ConfirmDeleteDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => { if (!o) setPendingDelete(null); }}
        title="Delete Annotation Field"
        confirmLabel="Delete Field"
        confirmDisabled={pendingDelete?.count === undefined}
        onConfirm={handleConfirmDelete}
      >
        <p className="font-medium text-destructive">Warning</p>
        <p className="mt-1 text-muted-foreground">
          You are about to permanently delete the field <strong>"{pendingDelete?.name}"</strong>{' '}
          and all of its annotations across every document in this project.
        </p>
        <p className="mt-1 text-muted-foreground">
          {pendingDelete?.count === undefined && 'Counting existing annotations…'}
          {pendingDelete?.count === null && 'The number of existing annotations could not be determined — the field may still contain data.'}
          {typeof pendingDelete?.count === 'number' && (
            pendingDelete.count === 0
              ? 'This field has no annotations yet.'
              : <>This field currently has <strong>{pendingDelete.count.toLocaleString()} annotation{pendingDelete.count === 1 ? '' : 's'}</strong>. This cannot be undone.</>
          )}
        </p>
      </ConfirmDeleteDialog>
    </div>
  );
};
