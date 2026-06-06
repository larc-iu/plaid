import { useState, useEffect } from 'react';
import { Plus, Trash2, Check, X, ChevronUp, ChevronDown } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { notifySuccess, notifyError, notifyInfo } from '@/utils/feedback';

// Predefined metadata fields common in linguistic annotation
const PREDEFINED_FIELDS = {
  'Date': true,
  'Speakers': true,
  'Location': true,
  'Genre': false,
  'Recording Quality': false,
  'Transcriber': false
};

export const DocumentMetadataManager = ({
  initialData,
  onLoadData,
  onSaveChanges,
  onError,
  isLoading = false,
  showTitle = true
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
        if (!fieldsData?.enabledFields) {
          fieldsData = {
            enabledFields: Object.entries(PREDEFINED_FIELDS).map(([name, enabled]) => ({
              name,
              enabled,
              isCustom: false
            }))
          };
        }

        setEnabledFields(fieldsData.enabledFields);
        setIsInitialized(true);
      } catch (error) {
        console.error('Failed to load metadata configuration:', error);
        // Still set as initialized even on error, so we show the default fields
        const defaultFields = Object.entries(PREDEFINED_FIELDS).map(([name, enabled]) => ({
          name,
          enabled,
          isCustom: false
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
    const updatedFields = enabledFields.map(field =>
      field.name === fieldName ? { ...field, enabled } : field
    );
    await saveChanges(updatedFields);
  };

  const handleAddCustomField = async () => {
    const trimmedName = newFieldName.trim();

    if (!trimmedName) {
      notifyError('Field name cannot be empty', 'Invalid Field Name');
      return;
    }

    // Check for duplicate names (case insensitive)
    const isDuplicate = enabledFields.some(field =>
      field.name.toLowerCase() === trimmedName.toLowerCase()
    );

    if (isDuplicate) {
      notifyError('A field with this name already exists', 'Duplicate Field');
      return;
    }

    const newField = {
      name: trimmedName,
      enabled: true, // New custom fields are enabled by default
      isCustom: true
    };

    const updatedFields = [...enabledFields, newField];
    await saveChanges(updatedFields);

    setNewFieldName('');
    notifySuccess(`"${trimmedName}" has been added to your metadata fields`, 'Field Added');
  };

  const handleDeleteCustomField = async (fieldName) => {
    const updatedFields = enabledFields.filter(field => field.name !== fieldName);
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
    return enabledFields.some(field =>
      field.name.toLowerCase() === trimmedName.toLowerCase()
    );
  };

  const handleMoveField = async (fieldName, direction) => {
    const currentIndex = enabledFields.findIndex(field => field.name === fieldName);
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
  const tableData = enabledFields.map((field, index) => ({
    ...field,
    id: `${field.name}-${index}` // Unique ID for table
  }));

  return (
    <div className="flex flex-col gap-8">
      {/* Metadata Fields Table. When embedded in a settings section the parent
          already supplies the card chrome, so don't nest another bordered card. */}
      <div className={showTitle ? 'rounded-lg border bg-card p-4' : ''}>
        {showTitle && <p className="mb-4 text-sm font-medium">Available Metadata Fields</p>}

        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="w-[10%] px-3 py-2 text-left font-medium">Enabled</th>
                <th className="w-[90%] px-3 py-2 text-left font-medium">Field Name</th>
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
                    <div className="flex items-center justify-between">
                      <span className={record.enabled ? undefined : 'italic text-muted-foreground'}>
                        {record.name}
                      </span>
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
                          disabled={tableData.findIndex(item => item.name === record.name) === 0}
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
                          disabled={tableData.findIndex(item => item.name === record.name) === tableData.length - 1}
                        >
                          <ChevronDown className="h-3 w-3" />
                        </Button>
                        <Button
                          size="icon"
                          variant="destructive"
                          className="h-7 w-7 transition-opacity"
                          style={{ opacity: hoveredField === record.name ? 1 : 0 }}
                          onClick={(event) => {
                            event.stopPropagation(); // Prevent row click when clicking delete
                            if (record.isCustom) {
                              handleDeleteCustomField(record.name);
                            } else {
                              // For predefined fields, reset to default value instead of deleting
                              const defaultEnabled = PREDEFINED_FIELDS[record.name] || false;
                              handleFieldToggle(record.name, defaultEnabled);
                            }
                          }}
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
