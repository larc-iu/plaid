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
import { useStrictClient } from '../../../contexts/StrictModeContext';


export const TimeAlignmentPopover = ({ 
  opened, 
  onClose, 
  selection,
  parsedDocument,
  project,
  onAlignmentCreated,
  selectionBox
}) => {
  const client = useStrictClient();
  const [mode, setMode] = useState('new'); // 'new', 'edit', or 'align'
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef(null);
  const focusTrapRef = useFocusTrap(opened);

  // Find existing alignment token that matches current selection
  const existingAlignment = parsedDocument?.alignmentTokens?.find(token => 
    token.metadata?.timeBegin === selection?.start && 
    token.metadata?.timeEnd === selection?.end
  );

  // Find available text boundaries for alignment
  const getAvailableTextBoundaries = () => {
    const alignmentTokens = parsedDocument?.alignmentTokens || [];
    const sortedTokens = [...alignmentTokens].sort((a, b) => 
      (a.metadata?.timeBegin || 0) - (b.metadata?.timeBegin || 0)
    );
    
    const textLength = parsedDocument?.document?.text?.body?.length || 0;
    
    // Find constraints from neighboring alignment tokens
    let leftBoundary = 0;
    let rightBoundary = textLength;
    
    for (const token of sortedTokens) {
      const tokenTimeBegin = token.metadata?.timeBegin || 0;
      const tokenTimeEnd = token.metadata?.timeEnd || 0;
      
      if (tokenTimeEnd <= selection.start && token.end > leftBoundary) {
        leftBoundary = token.end;
      }
      if (tokenTimeBegin >= selection.end && token.begin < rightBoundary) {
        rightBoundary = token.begin;
      }
    }
    
    return { leftBoundary, rightBoundary };
  };

  // Get available text for alignment
  const getAvailableText = () => {
    const { leftBoundary, rightBoundary } = getAvailableTextBoundaries();
    const fullText = parsedDocument?.document?.text?.body || '';
    return fullText.substring(leftBoundary, rightBoundary);
  };

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

  // Check if baseline text is available for alignment
  const hasAvailableText = () => {
    const availableText = getAvailableText();
    return availableText.trim().length > 0;
  };

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

  // Setup keyboard shortcuts
  useHotkeys([
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
    if (!text.trim() || saving) return;
    
    setSaving(true);
    try {
      if (mode === 'edit' && existingAlignment) {
        // Edit existing alignment
        await handleEditExisting();
      } else if (mode === 'align') {
        // Align existing baseline text
        await handleAlignExisting();
      } else {
        // Create new alignment
        await handleCreateNew();
      }
      
      notifications.show({
        title: 'Success',
        message: mode === 'edit' ? 'Alignment updated successfully' : 
                mode === 'align' ? 'Text aligned successfully' :
                'Time-aligned text created successfully',
        color: 'green'
      });
      
      // Reset and close
      setText('');
      setMode('new');
      onClose();
      
      // Notify parent to refresh
      if (onAlignmentCreated) {
        onAlignmentCreated();
      }
      
    } catch (error) {
      console.error('Failed to save alignment:', error);
      notifications.show({
        title: 'Error',
        message: 'Failed to save alignment: ' + error.message,
        color: 'red'
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!existingAlignment || saving) return;
    
    setSaving(true);
    try {
      // Get the text layer ID from parsed document
      const textId = parsedDocument?.layers?.primaryTextLayer?.text?.id;
      if (!textId) {
        throw new Error('Text layer not found');
      }

      // Get current text
      const currentText = parsedDocument?.document?.text?.body || '';
      
      // Remove the portion of text that corresponds to this alignment
      const tokenBegin = existingAlignment.begin;
      const tokenEnd = existingAlignment.end;
      
      let beforeText = currentText.substring(0, tokenBegin);
      let afterText = currentText.substring(tokenEnd);

      let trimIndex = beforeText.length;
      for (let i = beforeText.length - 1; i >= 0; i--) {
        if (/\s/.test(beforeText[i])) {
          trimIndex = i;
        } else {
          break;
        }
      }
      beforeText = beforeText.substring(0, trimIndex);
      for (let i = 0; i < afterText.length; i++) {
        if (/\s/.test(afterText[i])) {
          trimIndex = i;
        } else {
          break;
        }
      }
      afterText = afterText.substring(trimIndex);
      
      const numDeleted = currentText.length - (afterText.length + beforeText.length);
      const index = beforeText.length

      // Update the text
      await client.texts.update(textId, [{type: "delete", index: index, value: numDeleted}]);
      
      notifications.show({
        title: 'Success',
        message: 'Alignment deleted successfully',
        color: 'green'
      });
      
      // Reset and close
      setText('');
      setMode('new');
      onClose();
      
      // Notify parent to refresh
      if (onAlignmentCreated) {
        onAlignmentCreated();
      }
      
    } catch (error) {
      console.error('Failed to delete alignment:', error);
      notifications.show({
        title: 'Error',
        message: 'Failed to delete alignment: ' + error.message,
        color: 'red'
      });
    } finally {
      setSaving(false);
    }
  };

  const handleEditExisting = async () => {
    // Get the text layer ID from parsed document
    const textId = parsedDocument?.layers?.primaryTextLayer?.text?.id;
    if (!textId) {
      throw new Error('Text layer not found');
    }

    // Get current text
    const currentText = parsedDocument?.document?.text?.body || '';
    
    // Replace the portion of text that corresponds to this alignment
    const tokenBegin = existingAlignment.begin;
    const tokenEnd = existingAlignment.end;
    
    const beforeText = currentText.substring(0, tokenBegin);
    const afterText = currentText.substring(tokenEnd);
    const newText = beforeText + text.trim() + afterText;
    
    // Update the text
    try {
      // Editing text might have caused the token to shrink--new content at the end will not automatically cause the
      // token to grow, and more dramatically, if the entirety of the content was changed, it may have been deleted.
      // Assume that it did not change at first, and use the `_tokenizationDirty` flag to trigger any necessary sentence
      // expansion during parsing.
      client.beginBatch();
      client.texts.update(textId, newText);
      client.tokens.update(existingAlignment.id, tokenBegin, tokenBegin + text.trim().length);
      client.texts.setMetadata(textId, {...parsedDocument.document.text.metadata, _tokenizationDirty: true})
      await client.submitBatch()
    } catch (e) {
      // We failed--404 means the entirety of the contents was replaced.
      if (e.status === 404) {
        client.beginBatch();
        client.texts.update(textId, newText);
        client.tokens.create(
            parsedDocument?.layers?.alignmentTokenLayer.id,
            textId,
            tokenBegin,
            tokenBegin + text.trim().length,
            undefined,
            {timeBegin: selection.start, timeEnd: selection.end}
        );
        // We know we're replacing the entirety of the content if we got here, so just make a new sentence token
        client.tokens.create(
            parsedDocument?.layers?.sentenceTokenLayer.id,
            textId,
            tokenBegin,
            tokenBegin + text.trim().length,
        )
        await client.submitBatch()
      }
    }
  };

  const handleAlignExisting = async () => {
    // Get necessary layer IDs
    const primaryTextLayer = parsedDocument?.layers?.primaryTextLayer;
    const alignmentTokenLayer = parsedDocument?.layers?.alignmentTokenLayer;
    const sentenceTokenLayer = parsedDocument?.layers?.sentenceTokenLayer;
    
    if (!primaryTextLayer || !alignmentTokenLayer || !sentenceTokenLayer) {
      throw new Error('Required layers not found');
    }

    // Get text boundaries
    const { leftBoundary, rightBoundary } = getAvailableTextBoundaries();
    const fullText = parsedDocument?.document?.text?.body || '';
    
    // Find the actual text boundaries that match the user's selection
    const availableText = fullText.substring(leftBoundary, rightBoundary);
    const trimmedText = text.trim();
    
    // Find where in the available text our selection starts and ends
    const startInAvailable = availableText.indexOf(trimmedText);
    if (startInAvailable === -1) {
      throw new Error('Selected text not found in available text range');
    }
    
    // Calculate absolute positions
    const actualBegin = leftBoundary + startInAvailable;
    const actualEnd = actualBegin + trimmedText.length;
    
    // Don't modify the text, just create alignment token for existing text
    const textId = parsedDocument?.layers?.primaryTextLayer?.text?.id;
    
    client.beginBatch();
    
    // Create alignment token
    await client.tokens.create(
      alignmentTokenLayer.id,
      textId,
      actualBegin,
      actualEnd,
      undefined,
      {
        timeBegin: selection.start,
        timeEnd: selection.end
      }
    );
    
    await client.submitBatch();
    onAlignmentCreated();
  };

  const handleCreateNew = async () => {
    // Get necessary layer IDs
    const primaryTextLayer = parsedDocument?.layers?.primaryTextLayer;
    const alignmentTokenLayer = parsedDocument?.layers?.alignmentTokenLayer;
    const sentenceTokenLayer = parsedDocument?.layers?.sentenceTokenLayer;
    
    if (!primaryTextLayer || !alignmentTokenLayer || !sentenceTokenLayer) {
      throw new Error('Required layers not found');
    }

    // Get existing text ID from parsed document
    let textId = parsedDocument?.layers?.primaryTextLayer?.text?.id;

    client.beginBatch();

    // Get existing text and alignment tokens to determine insertion point
    const existingText = parsedDocument?.document?.text?.body || '';
    const alignmentTokens = parsedDocument?.alignmentTokens || [];

    // Sort alignment tokens by time
    const sortedTokens = [...alignmentTokens].sort((a, b) =>
        (a.metadata?.timeBegin || 0) - (b.metadata?.timeBegin || 0)
    );

    // Find where to insert based on time
    let insertPosition = existingText.length;
    let insertAfterToken = null;

    for (let i = 0; i < sortedTokens.length; i++) {
      const token = sortedTokens[i];
      if (token.metadata?.timeBegin && token.metadata.timeBegin <= selection.start) {
        insertAfterToken = token;
      } else {
        break;
      }
    }

    if (insertAfterToken) {
      insertPosition = insertAfterToken.end;
    } else if (sortedTokens.length > 0 && selection.start < (sortedTokens[0].metadata?.timeBegin || 0)) {
      // Insert at beginning
      insertPosition = 0;
    }

    // Insert text with proper spacing
    let insertedText;
    let insertBegin, insertEnd;
    let tokenBegin, tokenEnd;
    // Insert at the front
    if (insertPosition === 0) {
      const spaceAfter = (existingText ? ' ' : '')
      insertedText = text.trim() + spaceAfter;

      tokenBegin = 0;
      insertBegin = 0;
      tokenEnd = text.trim().length
      insertEnd = tokenEnd + (existingText ? 1 : 0);
    }
    // Insert at end
    else if (insertPosition >= existingText.length) {
      const spaceBefore = existingText ? ' ' : '';
      insertedText = spaceBefore + text.trim();

      insertBegin = existingText.length;
      tokenBegin = existingText.length + (spaceBefore ? 1 : 0);
      insertEnd = insertBegin + (spaceBefore ? 1 : 0) + text.trim().length;
      tokenEnd = insertEnd
    }
    // Insert in middle
    else {
      const before = existingText.substring(0, insertPosition);
      const after = existingText.substring(insertPosition);
      const spaceBefore = before.endsWith(' ') ? '' : ' ';
      const spaceAfter = after.startsWith(' ') ? '' : ' ';

      insertedText = spaceBefore + text.trim() + spaceAfter;
      insertBegin = insertPosition;
      insertEnd = insertBegin + spaceBefore.length + text.trim().length + spaceAfter.length;
      tokenBegin = insertPosition + (spaceBefore ? 1 : 0);
      tokenEnd = tokenBegin + text.trim().length + (spaceAfter ? 1 : 0)
    }

    await client.texts.update(textId, [{type: "insert", index: insertBegin, value: insertedText}]);
    await client.tokens.create(
        alignmentTokenLayer.id,
        textId,
        tokenBegin,
        tokenEnd,
        undefined,
        {
          timeBegin: selection.start,
          timeEnd: selection.end
        }
    );
    await client.tokens.create(
        sentenceTokenLayer.id,
        textId,
        insertBegin,
        insertEnd
    )

    await client.submitBatch();
    onAlignmentCreated();
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
              {mode === 'edit' ? 'Edit Alignment' : 
               mode === 'align' ? 'Align Baseline Text' : 
               'Create Time Alignment'}
            </Text>
            <Text size="xs" c="dimmed">
              {formatTime(selection?.start || 0)} - {formatTime(selection?.end || 0)}
              {mode === 'edit' && ' (editing existing)'}
              {mode === 'align' && ' (aligning baseline text)'}
            </Text>
          </div>

          {mode !== 'edit' && (
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

          {mode === 'align' && !hasAvailableText() ? (
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

          <Group justify="space-between">
            <div>
              {mode === 'edit' && (
                <Button
                  variant="light"
                  color="red"
                  onClick={handleDelete}
                  disabled={saving}
                >
                  Delete
                </Button>
              )}
            </div>
            <Group>
              <Button
                variant="subtle"
                onClick={handleCancel}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                loading={saving}
                disabled={!text.trim() || (mode === 'align' && !hasAvailableText())}
              >
                Save
              </Button>
            </Group>
          </Group>

          <Text size="xs" c="dimmed" style={{ fontStyle: 'italic' }}>
            Tip: Press Ctrl+Enter to save, Escape to cancel{mode === 'edit' ? ', Delete to remove' : ''}
            {mode === 'align' && '. Modify the text above to select which portion to align.'}
          </Text>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
};