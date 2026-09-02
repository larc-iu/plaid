import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  Plus,
  Trash2,
  RotateCcw,
  Check,
  X,
  ChevronUp,
  ChevronDown,
  AlertTriangle,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { notifySuccess, notifyError, notifyInfo } from '@/utils/feedback';

// Radix Select has no empty-string item value, so "no tagset" needs a sentinel.
const NO_TAGSET = '__none__';

// Predefined metadata fields common in linguistic annotation
const PREDEFINED_FIELDS = {
  Date: true,
  Speakers: true,
  Location: true,
  Genre: false,
  'Recording Quality': false,
  Transcriber: false,
};

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
  isLoading = false,
  showTitle = true,
  autoSaveDefaults = false, // Only auto-save defaults in setup mode
}) => {
  const [enabledFields, setEnabledFields] = useState([]);
  const [newFieldName, setNewFieldName] = useState('');
  const [hoveredField, setHoveredField] = useState(null);
  const [isInitialized, setIsInitialized] = useState(false);

  // Initialize data on mount
  useEffect(() => {
    const initializeData = async () => {
      try {
        let fieldsData = initialData;

        // If no initial data provided, try loading from callback
        if (!fieldsData && onLoadData) {
          fieldsData = await onLoadData();
        }

        // If still no data, use predefined fields as default
        let usedDefaults = false;
        if (!fieldsData?.enabledFields) {
          fieldsData = {
            enabledFields: Object.entries(PREDEFINED_FIELDS).map(([name, enabled]) => ({
              name,
              enabled,
              isCustom: false,
            })),
          };
          usedDefaults = true;
        }

        setEnabledFields(fieldsData.enabledFields);
        setIsInitialized(true);

        // In setup mode, persist the defaults into the wizard so the Confirmation
        // review reflects what will actually be created — these predefined fields
        // ARE created at setup even if the user never toggles them. Without this
        // the review silently omits the whole Document Metadata category.
        if (usedDefaults && autoSaveDefaults && onSaveChanges) {
          await onSaveChanges(fieldsData);
        }
      } catch (error) {
        console.error('Failed to load metadata configuration:', error);
        // Still set as initialized even on error, so we show the default fields
        const defaultFields = Object.entries(PREDEFINED_FIELDS).map(([name, enabled]) => ({
          name,
          enabled,
          isCustom: false,
        }));
        setEnabledFields(defaultFields);
        setIsInitialized(true);

        if (onError) {
          onError(error);
        } else {
          notifyError('Failed to load metadata configuration', 'Load Error');
        }
      }
    };

    initializeData();
  }, [initialData]);

  const saveChanges = async (newFields) => {
    try {
      if (onSaveChanges) {
        await onSaveChanges({ enabledFields: newFields });
      }
      setEnabledFields(newFields);
    } catch (error) {
      console.error('Failed to save metadata configuration:', error);
      if (onError) {
        onError(error);
      } else {
        notifyError('Failed to save metadata configuration', 'Save Error');
      }
    }
  };

  const handleFieldToggle = async (fieldName, enabled) => {
    const updatedFields = enabledFields.map((field) =>
      field.name === fieldName ? { ...field, enabled } : field,
    );
    await saveChanges(updatedFields);
  };

  const handleAddCustomField = async () => {
    const trimmedName = newFieldName.trim();

    if (!trimmedName) {
      notifyError('Field name cannot be empty', 'Invalid Field Name');
      return;
    }

    // A metadata field name reaches the query engine as a dot-path
    // (?d.metadata.<name>, see searchQueries.metadataFreqQuery), and the
    // parser splits field references on ".". A name containing one would scan
    // as having no values at all — a silent all-clear in the Validation tab
    // rather than an error.
    if (trimmedName.includes('.')) {
      notifyError('Field names cannot contain a period', 'Invalid Field Name');
      return;
    }

    // Check for duplicate names (case insensitive)
    const isDuplicate = enabledFields.some(
      (field) => field.name.toLowerCase() === trimmedName.toLowerCase(),
    );

    if (isDuplicate) {
      notifyError('A field with this name already exists', 'Duplicate Field');
      return;
    }

    const newField = {
      name: trimmedName,
      enabled: true, // New custom fields are enabled by default
      isCustom: true,
    };

    const updatedFields = [...enabledFields, newField];
    await saveChanges(updatedFields);

    setNewFieldName('');
    notifySuccess(`"${trimmedName}" has been added to your metadata fields`, 'Field Added');
  };

  const handleDeleteCustomField = async (fieldName) => {
    const updatedFields = enabledFields.filter((field) => field.name !== fieldName);
    await saveChanges(updatedFields);

    notifyInfo(`"${fieldName}" has been removed`, 'Field Removed');
  };

  const handleKeyPress = (event) => {
    if (event.key === 'Enter') {
      handleAddCustomField();
    }
  };

  // Check if new field name would be a duplicate
  const wouldBeDuplicate = () => {
    const trimmedName = newFieldName.trim();
    if (!trimmedName) return false;
    return enabledFields.some((field) => field.name.toLowerCase() === trimmedName.toLowerCase());
  };

  const handleMoveField = async (fieldName, direction) => {
    const currentIndex = enabledFields.findIndex((field) => field.name === fieldName);
    if (currentIndex === -1) return;

    const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (newIndex < 0 || newIndex >= enabledFields.length) return;

    const newFields = [...enabledFields];
    const [movedField] = newFields.splice(currentIndex, 1);
    newFields.splice(newIndex, 0, movedField);

    await saveChanges(newFields);
  };

  // Don't render until initialized (but don't block on external isLoading)
  if (!isInitialized) {
    return (
      <div className="rounded-lg border p-4 text-sm text-muted-foreground">
        Loading metadata configuration...
      </div>
    );
  }

  // Prepare data for the table
  // Point a metadata field at a tagset (or at none). Genre, Text type and
  // Region are the fields this is for: closed inventories far more naturally
  // than a gloss ever is.
  const handleSetTagset = async (name, choice) => {
    const tagset = choice === NO_TAGSET ? null : choice;
    const next = enabledFields.map((f) => (f.name === name ? { ...f, tagset } : f));
    setEnabledFields(next);
    if (onSaveChanges) await onSaveChanges({ enabledFields: next });
  };

  const tableData = enabledFields.map((field, index) => ({
    ...field,
    id: `${field.name}-${index}`, // Unique ID for table
  }));

  return (
    <div className="flex flex-col gap-8">
      {/* Metadata Fields Table */}
      <div>
        {showTitle && <p className="mb-4 text-sm font-medium">Available Metadata Fields</p>}

        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="w-[10%] px-3 py-2 text-left font-medium">Enabled</th>
                <th className="px-3 py-2 text-left font-medium">Field Name</th>
                {tagsetNames.length > 0 && (
                  <th className="w-[22%] px-3 py-2 text-left font-medium">Tagset</th>
                )}
                <th className="w-px px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {tableData.map((record) => (
                <tr
                  key={record.id}
                  className="cursor-pointer border-t hover:bg-muted/50"
                  onClick={() => handleFieldToggle(record.name, !record.enabled)}
                  onMouseEnter={() => setHoveredField(record.name)}
                  onMouseLeave={() => setHoveredField(null)}
                >
                  <td className="px-3 py-2">
                    {record.enabled ? (
                      <Check className="h-[18px] w-[18px] text-green-600" />
                    ) : (
                      <X className="h-[18px] w-[18px] text-muted-foreground" />
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span className={record.enabled ? undefined : 'italic text-muted-foreground'}>
                      {record.name}
                    </span>
                    {violations[`document:${record.name}`] > 0 && (
                      <Link
                        to={`/projects/${projectId}?tab=validate`}
                        onClick={(event) => event.stopPropagation()}
                        className="ml-2 inline-flex items-center gap-1 rounded bg-destructive/10 px-1.5 py-0.5 align-middle text-xs text-destructive hover:underline"
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
                    <div className="flex items-center gap-1">
                      <Button
                        size="icon"
                        variant="secondary"
                        className="h-7 w-7 transition-opacity"
                        style={{ opacity: hoveredField === record.name ? 1 : 0 }}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleMoveField(record.name, 'up');
                        }}
                        disabled={tableData.findIndex((item) => item.name === record.name) === 0}
                      >
                        <ChevronUp className="h-3 w-3" />
                      </Button>
                      <Button
                        size="icon"
                        variant="secondary"
                        className="h-7 w-7 transition-opacity"
                        style={{ opacity: hoveredField === record.name ? 1 : 0 }}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleMoveField(record.name, 'down');
                        }}
                        disabled={
                          tableData.findIndex((item) => item.name === record.name) ===
                          tableData.length - 1
                        }
                      >
                        <ChevronDown className="h-3 w-3" />
                      </Button>
                      <Button
                        size="icon"
                        variant={record.isCustom ? 'destructive' : 'secondary'}
                        title={record.isCustom ? 'Delete field' : 'Reset to default'}
                        className="h-7 w-7 transition-opacity"
                        style={{ opacity: hoveredField === record.name ? 1 : 0 }}
                        onClick={(event) => {
                          event.stopPropagation(); // Prevent row click when clicking the action
                          if (record.isCustom) {
                            handleDeleteCustomField(record.name);
                          } else {
                            // For predefined fields, reset to default value instead of deleting
                            const defaultEnabled = PREDEFINED_FIELDS[record.name] || false;
                            handleFieldToggle(record.name, defaultEnabled);
                          }
                        }}
                      >
                        {record.isCustom ? (
                          <Trash2 className="h-3.5 w-3.5" />
                        ) : (
                          <RotateCcw className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Add Custom Field */}
        <div className={showTitle ? 'p-4' : 'mt-4'}>
          <p className="mb-4 text-sm font-medium">Add Custom Field</p>
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
              <Plus className="h-4 w-4" /> Add Field
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
