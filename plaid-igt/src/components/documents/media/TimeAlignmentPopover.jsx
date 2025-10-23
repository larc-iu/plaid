import { useState, useEffect, useRef } from 'react';
import {
  Popover,
  Textarea,
  Button,
  Group,
  Stack,
  Text,
  SegmentedControl,
  Alert
} from '@mantine/core';
import { useFocusTrap, useHotkeys } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { useAlignmentEditor } from './useAlignmentEditor.js';

export const TimeAlignmentPopover = ({ 
  opened, 
  onClose, 
  selection,
  parsedDocument,
  project,
  projectId,
  documentId,
  onAlignmentCreated,
  selectionBox,
  client,
  readOnly = false
}) => {
  const [mode, setMode] = useState('new'); // 'new', 'edit', or 'align'
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef(null);
  const focusTrapRef = useFocusTrap(opened);

  // Use the alignment editor hook
  const {
    isProcessing,
    createAlignment,
    editAlignment,
    alignBaseline,
    deleteAlignment,
    getAvailableText,
    getExistingAlignment,
    canAlign
  } = useAlignmentEditor(selection, parsedDocument, project, projectId, documentId, client, onAlignmentCreated);

  // Find existing alignment token that matches current selection
  const existingAlignment = getExistingAlignment();

  // Set initial text and mode based on whether alignment exists
  useEffect(() => {
    if (opened) {
      if (existingAlignment) {
        setMode('edit');
        // Extract text using token positions from primary text layer
        const tokenText = parsedDocument?.document?.text?.body?.substring(
          existingAlignment.begin, 
          existingAlignment.end
        ) || '';
        setText(tokenText);
      } else {
        // Default to 'new' mode, let user choose
        setMode('new');
        setText('');
      }
    }
  }, [opened, existingAlignment]);

  // Handle mode changes
  const handleModeChange = (newMode) => {
    setMode(newMode);
    if (newMode === 'align') {
      const availableText = getAvailableText();
      setText(availableText);
    } else {
      setText('');
    }
  };

  // Auto-select text when editing existing alignment or aligning baseline text
  useEffect(() => {
    if (opened && (mode === 'edit' || mode === 'align') && textareaRef.current && text) {
      // Use requestAnimationFrame to ensure DOM is updated
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.select();
        }
      });
    }
  }, [opened, mode]);

  // Setup keyboard shortcuts (disabled in read-only mode)
  useHotkeys(readOnly ? [] : [
    ['Escape', () => {
      if (opened) {
        handleCancel();
      }
    }],
    ['ctrl+Enter', () => {
      if (opened) {
        handleSave();
      }
    }],
    ['cmd+Enter', () => {
      if (opened) {
        handleSave();
      }
    }],
    ['Delete', () => {
      if (opened && mode === 'edit') {
        handleDelete();
      }
    }]
  ]);

  const handleCancel = () => {
    setText('');
    setMode('new');
    onClose();
  };

  const handleSave = async () => {
    if (!text.trim() || saving || isProcessing) return;
    
    setSaving(true);
    try {
      if (mode === 'edit' && existingAlignment) {
        // Edit existing alignment
        await editAlignment(text, existingAlignment);
      } else if (mode === 'align') {
        // Align existing baseline text
        await alignBaseline(text);
      } else {
        // Create new alignment
        await createAlignment(text);
      }
      
      notifications.show({
        title: 'Success',
        message: mode === 'edit' ? 'Alignment updated successfully' : 
                mode === 'align' ? 'Text aligned successfully' :
                'Time-aligned text created successfully',
        color: 'green'
      });
      
      // Reset and close immediately
      setText('');
      setMode('new');
      onClose();
      
    } catch (error) {
      // Error handling is done in the hook
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!existingAlignment || saving || isProcessing) return;
    
    setSaving(true);
    try {
      await deleteAlignment(existingAlignment);
      
      notifications.show({
        title: 'Success',
        message: 'Alignment deleted successfully',
        color: 'green'
      });
      
      // Reset and close immediately
      setText('');
      setMode('new');
      onClose();
      
    } catch (error) {
      // Error handling is done in the hook
    } finally {
      setSaving(false);
    }
  };


  const formatTime = (seconds) => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  return (
    <Popover
      opened={opened}
      onClose={() => {}} // Don't close on click outside
      width={400}
      position="bottom"
      withArrow
      shadow="md"
      clickOutsideEvents={[]} // Disable click outside to close
      withinPortal={true} // Render in portal to avoid timeline event bubbling
    >
      <Popover.Target>
        {selectionBox}
      </Popover.Target>
      <Popover.Dropdown
        ref={focusTrapRef}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onMouseUp={(e) => e.stopPropagation()}
      >
        <Stack spacing="md">
          <div>
            <Text size="sm" fw={500}>
              {readOnly ? 'View Time Alignment' : (
                mode === 'edit' ? 'Edit Alignment' : 
                mode === 'align' ? 'Align Baseline Text' : 
                'Create Time Alignment'
              )}
            </Text>
            <Text size="xs" c="dimmed">
              {formatTime(selection?.start || 0)} - {formatTime(selection?.end || 0)}
              {readOnly && ' (read-only mode)'}
              {!readOnly && mode === 'edit' && ' (editing existing)'}
              {!readOnly && mode === 'align' && ' (aligning baseline text)'}
            </Text>
          </div>

          {!readOnly && mode !== 'edit' && (
            <SegmentedControl
              value={mode}
              onChange={handleModeChange}
              data={[
                { label: 'Create New', value: 'new' },
                { label: 'Align Existing', value: 'align' }
              ]}
              size="sm"
            />
          )}

          {readOnly ? (
            // Read-only content display
            <div>
              <Text size="sm" fw={500} mb="xs">Content</Text>
              <Text 
                size="sm" 
                style={{ 
                  backgroundColor: '#f8f9fa',
                  padding: '8px 12px',
                  borderRadius: '4px',
                  border: '1px solid #e9ecef',
                  minHeight: '60px',
                  display: 'flex',
                  alignItems: 'center'
                }}
              >
                {existingAlignment ? 
                  parsedDocument?.document?.text?.body?.substring(existingAlignment.begin, existingAlignment.end) || 'No content' :
                  'No alignment data for this time range'
                }
              </Text>
            </div>
          ) : mode === 'align' && !canAlign() ? (
            <Alert color="yellow">
              <Text size="sm">
                No unaligned baseline text is available in this time range. 
                All text between neighboring alignments has already been aligned.
              </Text>
            </Alert>
          ) : (mode === 'new' || mode === 'edit' || mode === 'align') && (
            <Textarea
              ref={textareaRef}
              label={mode === 'align' ? 'Baseline Text to Align' : 'Transcription'}
              placeholder={mode === 'align' ? 'Select portion of text to align...' : 'Enter the text for this time segment...'}
              value={text}
              onChange={(e) => setText(e.target.value)}
              minRows={3}
              maxRows={8}
              autosize
              required
              data-autofocus
              description={mode === 'align' ? 'Edit this text to select the portion you want to align with the time selection.' : undefined}
            />
          )}

          {readOnly ? (
            // Read-only mode: just a close button
            <Group justify="flex-end">
              <Button
                variant="subtle"
                onClick={handleCancel}
              >
                Close
              </Button>
            </Group>
          ) : (
            // Edit mode: full set of action buttons
            <Group justify="space-between">
              <div>
                {mode === 'edit' && (
                  <Button
                    variant="light"
                    color="red"
                    onClick={handleDelete}
                    disabled={saving || isProcessing}
                  >
                    Delete
                  </Button>
                )}
              </div>
              <Group>
                <Button
                  variant="subtle"
                  onClick={handleCancel}
                  disabled={saving || isProcessing}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleSave}
                  loading={saving || isProcessing}
                  disabled={!text.trim() || (mode === 'align' && !canAlign())}
                >
                  Save
                </Button>
              </Group>
            </Group>
          )}

          <Text size="xs" c="dimmed" style={{ fontStyle: 'italic' }}>
            {readOnly ? (
              'Read-only mode: Content cannot be modified in this view.'
            ) : (
              <>
                Tip: Press Ctrl+Enter to save, Escape to cancel{mode === 'edit' ? ', Delete to remove' : ''}
                {mode === 'align' && '. Modify the text above to select which portion to align.'}
              </>
            )}
          </Text>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
};