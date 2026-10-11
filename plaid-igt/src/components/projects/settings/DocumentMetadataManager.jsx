import { useState } from 'react';
import { PLAID_NAMESPACE, isReservedMetadataKey } from '@larc-iu/plaid-client';
import { PREDEFINED_FIELDS } from '@/domain/igtConfig';
import { Link } from 'react-router-dom';
import { Plus, RotateCcw, AlertTriangle } from 'lucide-react';
import { Input } from '@ui/components/ui/input';
import { Button } from '@ui/components/ui/button';
import { nameKey } from '@ui/lib/nameKey.js';
import { sameNameIgnoringCase } from '@/domain/nameMatch';
import { RowControls } from '@/components/shared/RowControls';
import { useListManager } from './useListManager';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@ui/components/ui/select';
import { notifySuccess, notifyError, notifyInfo } from '@/utils/feedback';

// Radix Select has no empty-string item value, so "no tagset" needs a sentinel.
const NO_TAGSET = '__none__';

const defaultFields = () =>
  Object.entries(PREDEFINED_FIELDS).map(([name, enabled]) => ({ name, enabled, isCustom: false }));

export const DocumentMetadataManager = ({
  initialData,
  onLoadData,
  onSaveChanges,
  // The project's tagset names, for the per-field picker.
  tagsetNames = [],
  // "document:<field>" -> how many values its tagset refuses.
  violations = {},
  projectId,
  onError,
  showTitle = true,
  autoSaveDefaults = false, // Only auto-save defaults in setup mode
}) => {
  // The setup wizard saves the predefined fields at once: they are created
  // even if never touched, and its review would otherwise leave them out.
  const {
    items: enabledFields,
    setItems: setEnabledFields,
    isInitialized,
    save: saveChanges,
    move,
    report,
  } = useListManager({
    listKey: 'enabledFields',
    noun: 'metadata fields',
    defaults: defaultFields,
    initialData,
    onLoadData,
    onSaveChanges,
    onError,
    autoSaveDefaults,
  });
  const [newFieldName, setNewFieldName] = useState('');

  const handleFieldToggle = async (fieldName, enabled) => {
    const updatedFields = enabledFields.map((field) =>
      field.name === fieldName ? { ...field, enabled } : field,
    );
    await saveChanges(updatedFields);
  };

  const handleAddCustomField = async () => {
    // composed, as the server stores a name, so the duplicate check below
    // finds a field typed in another spelling
    const trimmedName = nameKey(newFieldName).trim();

    if (!trimmedName) {
      notifyError('Field name cannot be empty', 'Invalid field name');
      return;
    }

    // A metadata field name reaches the query engine as a dot-path
    // (?d.metadata.<name>, see searchQueries.metadataFreqQuery), and the
    // parser splits field references on ".". A name containing one would scan
    // as having no values at all — a silent all-clear in the Validation tab
    // rather than an error.
    if (trimmedName.includes('.')) {
      notifyError('Field names cannot contain a period', 'Invalid field name');
      return;
    }

    // `plaid` holds the settings every app shares (the text direction among
    // them), and the provenance keys record who made the document. A field's
    // value written to either would replace them.
    if (isReservedMetadataKey(trimmedName)) {
      notifyError(
        trimmedName === PLAID_NAMESPACE
          ? `${trimmedName} is reserved for document settings`
          : `${trimmedName} is reserved for provenance`,
        'Invalid field name',
      );
      return;
    }

    if (enabledFields.some((field) => sameNameIgnoringCase(field.name, trimmedName))) {
      notifyError('A field with this name already exists', 'Duplicate field');
      return;
    }

    await saveChanges([...enabledFields, { name: trimmedName, enabled: true, isCustom: true }]);

    setNewFieldName('');
    notifySuccess(`Field “${trimmedName}” added`);
  };

  const handleDeleteCustomField = async (fieldName) => {
    await saveChanges(enabledFields.filter((field) => field.name !== fieldName));
    notifyInfo(`Field “${fieldName}” removed`);
  };

  const handleKeyPress = (event) => {
    if (event.key === 'Enter') {
      handleAddCustomField();
    }
  };

  const wouldBeDuplicate = () => {
    const trimmedName = newFieldName.trim();
    if (!trimmedName) return false;
    return enabledFields.some((field) => sameNameIgnoringCase(field.name, trimmedName));
  };

  if (!isInitialized) {
    return <div className="rounded-lg border p-4 text-sm text-muted-foreground">Loading…</div>;
  }

  // Point a metadata field at a tagset (or at none). Genre, Text type and
  // Region are the fields this is for: closed inventories far more naturally
  // than a gloss ever is.
  const handleSetTagset = async (name, choice) => {
    const tagset = choice === NO_TAGSET ? null : choice;
    const before = enabledFields;
    const next = enabledFields.map((f) => (f.name === name ? { ...f, tagset } : f));
    setEnabledFields(next);
    try {
      if (onSaveChanges) await onSaveChanges({ enabledFields: next });
    } catch (error) {
      // Shown at once, put back when refused.
      console.error('Failed to save the metadata fields:', error);
      setEnabledFields(before);
      report(error, 'Failed to save the metadata fields');
    }
  };

  const tableData = enabledFields.map((field, index) => ({
    ...field,
    id: `${field.name}-${index}`,
  }));

  return (
    <div className="flex flex-col gap-8">
      {/* Metadata Fields Table */}
      <div>
        {showTitle && <p className="mb-4 text-sm font-medium">Metadata fields</p>}

        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="w-[10%] px-3 py-2 text-left font-medium">Enabled</th>
                <th className="px-3 py-2 text-left font-medium">Field name</th>
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
                  className="cursor-pointer border-t hover:bg-muted/50"
                  onClick={() => handleFieldToggle(record.name, !record.enabled)}
                >
                  <td className="px-3 py-2">
                    {/* A checkbox, not a tick-or-cross glyph, and the same
                        control the vocabulary list uses. A glyph reads as a
                        status and not something to click, so the row was the
                        only affordance and the only feedback was a mark
                        changing shape at the far left. The row still toggles. */}
                    <input
                      type="checkbox"
                      className="h-4 w-4 cursor-pointer accent-primary"
                      checked={record.enabled}
                      aria-label={`${record.enabled ? 'Disable' : 'Enable'} ${record.name}`}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => handleFieldToggle(record.name, event.target.checked)}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <span className={record.enabled ? undefined : 'italic text-muted-foreground'}>
                      {record.name}
                    </span>
                    {violations[`document:${record.name}`] > 0 && (
                      <Link
                        to={`/projects/${projectId}?tab=validate`}
                        onClick={(event) => event.stopPropagation()}
                        className="ml-2 inline-flex items-center gap-1 rounded-sm bg-destructive/10 px-1.5 py-0.5 align-middle text-xs text-destructive hover:underline"
                        title="Show these in the Validation tab"
                      >
                        <AlertTriangle className="h-3 w-3" />
                        {violations[`document:${record.name}`]} outside the tagset
                      </Link>
                    )}
                  </td>
                  {tagsetNames.length > 0 && (
                    <td className="px-3 py-2" onClick={(event) => event.stopPropagation()}>
                      <Select
                        value={record.tagset ?? NO_TAGSET}
                        onValueChange={(v) => handleSetTagset(record.name, v)}
                        disabled={!record.enabled}
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
                              renamed or deleted; keep the dangling name visible
                              rather than letting it read as "none". */}
                          {record.tagset && !tagsetNames.includes(record.tagset) && (
                            <SelectItem value={record.tagset}>{record.tagset} (missing)</SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                    </td>
                  )}
                  <td className="w-px whitespace-nowrap px-3 py-2">
                    {/* A predefined field is not deleted but reset to its default. */}
                    <RowControls
                      name={record.name}
                      onUp={() => move(index, index - 1)}
                      onDown={() => move(index, index + 1)}
                      canUp={index > 0}
                      canDown={index < tableData.length - 1}
                      onRemove={() =>
                        record.isCustom
                          ? handleDeleteCustomField(record.name)
                          : handleFieldToggle(record.name, PREDEFINED_FIELDS[record.name] || false)
                      }
                      {...(record.isCustom
                        ? {}
                        : {
                            removeLabel: 'Reset to default',
                            removeIcon: RotateCcw,
                            destructive: false,
                          })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Add a field */}
        <div className={showTitle ? 'p-4' : 'mt-4'}>
          <p className="mb-4 text-sm font-medium">Add a field</p>
          <div className="flex items-center gap-2">
            <Input
              placeholder="Enter custom field name"
              value={newFieldName}
              onChange={(event) => setNewFieldName(event.target.value)}
              onKeyDown={handleKeyPress}
              className="flex-1"
            />
            <Button
              onClick={handleAddCustomField}
              disabled={!newFieldName.trim() || wouldBeDuplicate()}
            >
              <Plus className="h-4 w-4" /> Add field
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
