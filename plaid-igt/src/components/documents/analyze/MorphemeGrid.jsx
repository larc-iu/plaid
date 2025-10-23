import React, { useState, useRef, useEffect, useMemo, useImperativeHandle } from 'react';
import { VocabLinkPopover } from './VocabLinkPopover.jsx';

// Shared throttle for tab navigation (same as EditableCell)
let lastGlobalTabPress = 0;


// Vanilla JS editor class for morpheme field editing
class MorphemeFieldEditor {
  constructor(element, options) {
    this.element = element;
    this.options = options;
    this.isDestroyed = false;
    
    this.setupElement();
    this.attachEventListeners();
    
    console.log(`[MorphemeFieldEditor] Created editor for field: ${options.field}, morpheme: ${options.morphemeId}`);
  }
  
  setupElement() {
    if (this.isDestroyed) return;
    
    this.element.contentEditable = !this.options.readOnly;
    this.element.textContent = this.options.value || '';
    
    // Apply classes for styling
    const baseClasses = ['editable-field'];
    if (this.options.isFormField) {
      baseClasses.push('morpheme-form-field');
    } else {
      baseClasses.push('morpheme-annotation-field');
    }
    
    if (this.element.textContent.trim()) {
      baseClasses.push('editable-field--filled');
    } else {
      baseClasses.push('editable-field--empty');
    }
    
    this.element.className = baseClasses.join(' ');
    
    // Set other attributes
    if (this.options.morphemeId && this.options.field) {
      this.element.id = `${this.options.morphemeId}-${this.options.field}`;
    }
    
    if (this.options.tabIndex) {
      this.element.tabIndex = this.options.tabIndex;
    }
    
    this.element.title = `Edit ${this.options.field || 'morpheme'}`;
  }
  
  attachEventListeners() {
    if (this.isDestroyed) return;
    
    // Bind methods to preserve 'this' context
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleInput = this.handleInput.bind(this);
    this.handleBlur = this.handleBlur.bind(this);
    this.handleFocus = this.handleFocus.bind(this);
    
    this.element.addEventListener('keydown', this.handleKeyDown);
    this.element.addEventListener('input', this.handleInput);
    this.element.addEventListener('blur', this.handleBlur);
    this.element.addEventListener('focus', this.handleFocus);
  }
  
  handleKeyDown(e) {
    console.log(`[MorphemeFieldEditor] Key pressed: "${e.key}" in field: ${this.options.field}`);
    
    // Throttle tab key presses to prevent browser hanging
    if (e.key === 'Tab') {
      const now = Date.now();
      if (now - lastGlobalTabPress < 55) {
        e.preventDefault();
        return;
      }
      lastGlobalTabPress = now;
      // Let browser handle normal tab navigation
    }
    
    if (e.key === 'Enter') {
      e.preventDefault();
      this.element.blur();
    } else if (e.key === 'Escape') {
      this.element.textContent = this.options.value || '';
      this.element.blur();
    } else if (this.options.isFormField) {
      // Special handling for form fields
      if (e.key === '-' && !e.ctrlKey && !e.metaKey) {
        this.splitAtCursor(e);
      } else if (e.key === 'Backspace') {
        const currentText = this.element.textContent || '';
        const selection = window.getSelection();
        
        // Check if cursor is at position 0
        if (selection.rangeCount > 0) {
          const range = selection.getRangeAt(0);
          const cursorPosition = range.startOffset;
          
          // If cursor is at position 0 with no selection and this isn't the first morpheme, merge with previous
          if (cursorPosition === 0 && range.startOffset === range.endOffset && this.options.onMergeWithPrevious) {
            e.preventDefault();
            console.log(`[MorphemeFieldEditor] Merging with previous morpheme - current text: "${currentText}"`);
            this.options.onMergeWithPrevious(currentText);
            return;
          }
        }
        
        // Original delete logic for empty morphemes
        if (currentText.trim() === '' && this.options.canDelete) {
          e.preventDefault();
          console.log(`[MorphemeFieldEditor] Deleting empty morpheme: ${this.options.morphemeId}`);
          if (this.options.onDelete) {
            this.options.onDelete();
          }
        }
      }
    }
  }
  
  handleInput(e) {
    const newContent = e.target.textContent || '';
    console.log(`[MorphemeFieldEditor] Input changed to: "${newContent}"`);
    
    // Update classes based on content
    if (newContent.trim()) {
      this.element.classList.remove('editable-field--empty');
      this.element.classList.add('editable-field--filled');
    } else {
      this.element.classList.remove('editable-field--filled');
      this.element.classList.add('editable-field--empty');
    }
  }
  
  handleBlur(e) {
    const newValue = (e.target.textContent || '').trim();
    console.log(`[MorphemeFieldEditor] Blur - value changed from "${this.options.value}" to "${newValue}"`);
    
    if (newValue !== (this.options.value || '')) {
      console.log(`[MorphemeFieldEditor] Calling onUpdate with: "${newValue}"`);
      if (this.options.onUpdate) {
        this.options.onUpdate(newValue);
      }
    }
  }
  
  handleFocus(e) {
    console.log(`[MorphemeFieldEditor] Focus gained on field: ${this.options.field}`);
    
    // Select all content when focused
    setTimeout(() => {
      if (!this.isDestroyed && document.activeElement === this.element) {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(this.element);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }, 0);
  }
  
  splitAtCursor(e) {
    e.preventDefault();
    console.log(`[MorphemeFieldEditor] Splitting morpheme at cursor`);
    
    const currentText = this.element.textContent || '';
    const selection = window.getSelection();
    
    if (selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const cursorPosition = range.startOffset;
      
      const leftPart = currentText.slice(0, cursorPosition);
      const rightPart = '-' + currentText.slice(cursorPosition);
      
      console.log(`[MorphemeFieldEditor] Split: left="${leftPart}", right="${rightPart}", cursor=${cursorPosition}`);
      
      // Update current element immediately
      this.element.textContent = leftPart;
      
      // Notify React to handle the split
      if (this.options.onSplit) {
        this.options.onSplit(leftPart, rightPart);
      }
    } else {
      console.log('[MorphemeFieldEditor] No selection range available for split');
    }
  }
  
  setValue(newValue) {
    if (this.isDestroyed) return;
    
    const currentValue = this.element.textContent || '';
    if (currentValue !== (newValue || '')) {
      console.log(`[MorphemeFieldEditor] Setting value from "${currentValue}" to "${newValue}"`);
      this.element.textContent = newValue || '';
      this.options.value = newValue;
      
      // Update classes
      if (newValue && newValue.trim()) {
        this.element.classList.remove('editable-field--empty');
        this.element.classList.add('editable-field--filled');
      } else {
        this.element.classList.remove('editable-field--filled');
        this.element.classList.add('editable-field--empty');
      }
    }
  }
  
  focus(cursorPosition = null) {
    if (!this.isDestroyed) {
      this.element.focus();
      
      // Position cursor if specified
      if (cursorPosition !== null) {
        setTimeout(() => {
          if (!this.isDestroyed && document.activeElement === this.element) {
            const selection = window.getSelection();
            const range = document.createRange();
            
            // Ensure we don't exceed text length
            const textLength = this.element.textContent?.length || 0;
            const position = Math.min(cursorPosition, textLength);
            
            try {
              if (this.element.firstChild) {
                range.setStart(this.element.firstChild, position);
                range.setEnd(this.element.firstChild, position);
              } else {
                range.setStart(this.element, 0);
                range.setEnd(this.element, 0);
              }
              selection.removeAllRanges();
              selection.addRange(range);
            } catch (e) {
              // Fallback: just focus without positioning
              console.log('[MorphemeFieldEditor] Could not position cursor:', e);
            }
          }
        }, 0);
      }
    }
  }
  
  destroy() {
    if (this.isDestroyed) return;
    
    console.log(`[MorphemeFieldEditor] Destroying editor for field: ${this.options.field}`);
    this.isDestroyed = true;
    
    this.element.removeEventListener('keydown', this.handleKeyDown);
    this.element.removeEventListener('input', this.handleInput);
    this.element.removeEventListener('blur', this.handleBlur);
    this.element.removeEventListener('focus', this.handleFocus);
  }
}

// React wrapper component for vanilla JS morpheme field editor
const VanillaMorphemeField = React.forwardRef(({ 
  value, 
  morphemeId, 
  field, 
  isFormField = false,
  canDelete = false,
  readOnly = false,
  tabIndex,
  onUpdate, 
  onSplit, 
  onDelete,
  onMergeWithPrevious,
  placeholder,
  ...props 
}, ref) => {
  const elementRef = useRef(null);
  const editorRef = useRef(null);
  
  // Create editor on mount
  useEffect(() => {
    if (elementRef.current) {
      editorRef.current = new MorphemeFieldEditor(elementRef.current, {
        value,
        morphemeId,
        field,
        isFormField,
        canDelete,
        readOnly,
        tabIndex,
        onUpdate,
        onSplit,
        onDelete,
        onMergeWithPrevious
      });
      
      return () => {
        editorRef.current?.destroy();
      };
    }
  }, []);
  
  // Update editor when value changes externally
  useEffect(() => {
    editorRef.current?.setValue(value);
  }, [value]);
  
  // Update editor options when props change
  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.options = {
        ...editorRef.current.options,
        readOnly,
        canDelete,
        onUpdate,
        onSplit,
        onDelete,
        onMergeWithPrevious
      };
    }
  }, [readOnly, canDelete, onUpdate, onSplit, onDelete, onMergeWithPrevious]);
  
  // Expose focus method via ref
  useImperativeHandle(ref, () => ({
    focus: (cursorPosition) => editorRef.current?.focus(cursorPosition),
    setValue: (val) => editorRef.current?.setValue(val)
  }));
  
  return (
    <div
      ref={elementRef}
      {...props}
    />
  );
});


// Individual morpheme column component
const MorphemeColumn = React.memo(React.forwardRef(({ 
  morpheme, 
  morphemeIndex, 
  morphemeFields, 
  operations, 
  vocabularies,
  readOnly, 
  wordToken,
  getTabIndex,
  onSplit,
  onDelete,
  onMergeWithPrevious,
  onVocabLinkUpdate,
  fullOperations
}, ref) => {
  const handleFormUpdate = (value) => {
    operations.updateMorphemeForm(morpheme, value);
  };

  const handleSpanUpdate = (field, value) => {
    operations.updateMorphemeSpan(morpheme, field, value);
  };

  const handleSplitMorpheme = (leftForm, rightForm) => {
    console.log(`[MorphemeColumn] handleSplitMorpheme called - left: "${leftForm}", right: "${rightForm}"`);
    if (onSplit) {
      onSplit(morpheme, leftForm, rightForm);
    }
  };

  const handleDeleteMorpheme = () => {
    if (onDelete) {
      onDelete(morpheme);
    }
  };

  const handleMergeWithPrevious = (currentText) => {
    if (onMergeWithPrevious) {
      onMergeWithPrevious(morphemeIndex, currentText);
    }
  };

  // Get morpheme form - prefer vocab item form, then metadata.form (even if empty), then content
  const morphemeForm = morpheme.vocabItem?.form || 
    (morpheme.metadata && 'form' in morpheme.metadata ? morpheme.metadata.form : morpheme.content) || '';
  
  console.log(`[MorphemeColumn] Rendering morpheme ${morpheme.id} with form: "${morphemeForm}"`);
  console.log(`[MorphemeColumn] Morpheme object:`, morpheme);

  return (
    <div className="morpheme-column">
      {/* Morpheme form row */}
      <div className="morpheme-form">
        <VocabLinkPopover
          vocabularies={vocabularies}
          token={morpheme}
          operations={fullOperations}
          onVocabLinkUpdate={onVocabLinkUpdate}
          readOnly={readOnly}
        >
          <VanillaMorphemeField
            ref={ref}
            value={morphemeForm}
            morphemeId={morpheme.id}
            field="form"
            tabIndex={getTabIndex(morphemeIndex, 'form')}
            placeholder=""
            readOnly={readOnly}
            isFormField={true}
            canDelete={morphemeIndex > 0} // Can't delete the first morpheme
            onUpdate={handleFormUpdate}
            onSplit={handleSplitMorpheme}
            onDelete={handleDeleteMorpheme}
            onMergeWithPrevious={morphemeIndex > 0 ? handleMergeWithPrevious : undefined}
          />
        </VocabLinkPopover>
      </div>
      
      {/* Morpheme annotation rows */}
      {morphemeFields.map(field => (
        <div key={`${morpheme.id}-${field.id}`} className="morpheme-annotation-cell">
          <VanillaMorphemeField
            value={morpheme.annotations[field.name]?.value || ''}
            morphemeId={morpheme.id}
            field={field.name}
            tabIndex={getTabIndex(morphemeIndex, field.name)}
            placeholder=""
            readOnly={readOnly}
            isFormField={false}
            onUpdate={(value) => handleSpanUpdate(field, value)}
          />
        </div>
      ))}
    </div>
  );
}), (prevProps, nextProps) => {
  // Custom comparison function to prevent unnecessary re-renders
  return (
    prevProps.morpheme.id === nextProps.morpheme.id &&
    prevProps.morphemeIndex === nextProps.morphemeIndex &&
    prevProps.readOnly === nextProps.readOnly &&
    JSON.stringify(prevProps.morpheme.metadata) === JSON.stringify(nextProps.morpheme.metadata) &&
    JSON.stringify(prevProps.morpheme.annotations) === JSON.stringify(nextProps.morpheme.annotations) &&
    prevProps.morpheme.vocabItem?.form === nextProps.morpheme.vocabItem?.form
  );
});

  // Placeholder column component - defined inside MorphemeGrid for access to handlers
  const PlaceholderMorphemeColumn = React.memo(({ 
  morphemeFields, 
  onCreateMorpheme,
  onCreateMultipleMorphemes,
  wordToken,
  getTabIndex,
  readOnly,
  morphemeCount
}) => {
  const [localForm, setLocalForm] = useState('');
  const inputRef = useRef(null);

  const handleFormUpdate = (value) => {
    if (value.trim() && onCreateMorpheme) {
      setLocalForm('');
      onCreateMorpheme(wordToken, morphemeCount + 1, value.trim());
    }
  };

  const handleKeyDown = (e) => {
    console.log(`[MorphemeGrid Placeholder] handleKeyDown - key: "${e.key}"`);
    
    if (e.key === 'Tab') {
      const now = Date.now();
      if (now - lastGlobalTabPress < 55) {
        e.preventDefault();
        return;
      }
      lastGlobalTabPress = now;
    }
    
    // Handle dash key for splitting
    if (e.key === '-' && !e.ctrlKey && !e.metaKey) {
      console.log('[MorphemeGrid Placeholder] Dash key pressed - creating morphemes');
      e.preventDefault();
      
      const currentText = e.target.textContent || '';
      const selection = window.getSelection();
      
      if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        const cursorPosition = range.startOffset;
        
        const leftPart = currentText.slice(0, cursorPosition);
        const rightPart = '-' + currentText.slice(cursorPosition);
        
        console.log(`[MorphemeGrid Placeholder] Creating morphemes - left: "${leftPart}", right: "${rightPart}"`);
        
        // Build the morphemes to create
        const morphemesToCreate = [];
        
        // Add left part if not empty
        if (leftPart.trim()) {
          morphemesToCreate.push({ precedence: 1, form: leftPart });
        }
        
        // Add right part (always)
        morphemesToCreate.push({ 
          precedence: leftPart.trim() ? 2 : 1, 
          form: rightPart 
        });
        
        // Create all morphemes at once
        console.log(`[MorphemeGrid Placeholder] Calling onCreateMultipleMorphemes with:`, morphemesToCreate);
        onCreateMultipleMorphemes(wordToken, morphemesToCreate);
        
        // Clear the placeholder
        e.target.textContent = '';
        setLocalForm('');
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const value = (e.target.textContent || '').trim();
      if (value && onCreateMorpheme) {
        setLocalForm('');
        e.target.textContent = '';
        onCreateMorpheme(wordToken, morphemeCount + 1, value);
      }
    }
  };

  return (
    <div className="morpheme-column morpheme-column--placeholder">
      {/* Placeholder form row */}
      <div className="morpheme-form">
        <div
          ref={inputRef}
          contentEditable={!readOnly}
          className="editable-field editable-field--empty morpheme-form-field morpheme-form-field--placeholder"
          onInput={(e) => setLocalForm(e.target.textContent)}
          onBlur={(e) => {
            const value = (e.target.textContent || '').trim();
            if (value && onCreateMorpheme) {
              setLocalForm('');
              e.target.textContent = '';
              onCreateMorpheme(wordToken, morphemeCount + 1, value);
            }
          }}
          onKeyDown={handleKeyDown}
          tabIndex={getTabIndex(morphemeCount, 'form')}
          suppressContentEditableWarning={true}
          title="Add new morpheme"
        />
      </div>
      
      {/* Empty annotation rows */}
      {morphemeFields.map(field => (
        <div key={`placeholder-${field.id}`} className="morpheme-annotation-cell">
          {/* Empty cell */}
        </div>
      ))}
    </div>
  );
});

// Utility function to generate temporary IDs for optimistic updates
const generateTempId = () => `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

// Main MorphemeGrid component
export const MorphemeGrid = ({ 
  token, 
  morphemeFields,
  morphemeLayerId,
  operations, 
  vocabularies,
  readOnly, 
  getTabIndex,
  sentenceIndex 
}) => {
  // Local state management
  const pristineMorphemes = useMemo(() => token.morphemes || [], [token.morphemes]);
  const [localState, setLocalState] = useState({
    morphemes: [...pristineMorphemes],
    tempIdMap: new Map() // Map temp IDs to real IDs after API success
  });
  
  // Refs for focus management
  const gridRef = useRef(null);
  const morphemeRefs = useRef(new Map()); // Map of morpheme IDs to refs
  const tempIdMapRef = useRef(new Map()); // Current temp ID mappings
  const deletedIdsRef = useRef(new Set()); // Track deleted morpheme IDs
  
  // Update local state when token morphemes change (document reload)
  useEffect(() => {
    setLocalState(prevState => ({
      ...prevState,
      morphemes: [...pristineMorphemes]
      // Keep tempIdMap during document refreshes
    }));
  }, [pristineMorphemes]);
  
  // Keep tempIdMapRef in sync with state
  useEffect(() => {
    tempIdMapRef.current = localState.tempIdMap;
  }, [localState.tempIdMap]);
  
  // Helper function to update local morphemes
  const updateLocalMorphemes = (updater) => {
    setLocalState(prevState => ({
      ...prevState,
      morphemes: updater(prevState.morphemes)
    }));
  };
  
  // Helper function to resolve temp IDs to real IDs
  const resolveToRealId = (morphemeId) => {
    if (!morphemeId) return null;
    
    // Check if this ID has been deleted
    if (deletedIdsRef.current.has(morphemeId)) {
      console.warn(`[MorphemeGrid] Attempted to resolve deleted ID: ${morphemeId}`);
      return null;
    }
    
    // If it's not a temp ID, return as-is
    if (!morphemeId.startsWith('temp_')) {
      return morphemeId;
    }
    
    // Look up in the current temp ID map
    const realId = tempIdMapRef.current.get(morphemeId);
    if (!realId) {
      console.warn(`[MorphemeGrid] No real ID mapping found for temp ID: ${morphemeId}`);
      return null;
    }
    
    // Check if the resolved real ID has been deleted
    if (deletedIdsRef.current.has(realId)) {
      console.warn(`[MorphemeGrid] Resolved to deleted real ID: ${realId}`);
      return null;
    }
    
    return realId;
  };

  
  // Create new morpheme with optimistic updates
  const handleCreateMorpheme = async (wordToken, precedence, form) => {
    console.log(`[MorphemeGrid] handleCreateMorpheme - precedence: ${precedence}, form: "${form}"`);
    
    const tempMorphemeId = generateTempId();
    
    // Create new morpheme object
    const newMorpheme = {
      id: tempMorphemeId,
      text: token.text,
      begin: token.begin,
      end: token.end,
      precedence: precedence,
      content: form,
      metadata: { form: form },
      annotations: {},
      vocabItem: null
    };
    
    // OPTIMISTIC UPDATE: Add morpheme to UI immediately
    updateLocalMorphemes(morphemes => {
      const newMorphemes = [...morphemes, newMorpheme];
      return newMorphemes;
    });
    
    // BACKGROUND API CALLS
    try {
      console.log(`[MorphemeGrid] Creating single morpheme via API - precedence: ${precedence}, form: "${form}", morphemeLayerId: ${morphemeLayerId}`);
      
      // For single morpheme creation, we don't need batching
      const result = await operations.client.tokens.create(
        morphemeLayerId,
        token.text,
        token.begin,
        token.end,
        precedence,
        form ? { form } : undefined
      );
      
      console.log(`[MorphemeGrid] API result:`, result);
      
      if (result && result.id) {
        console.log(`[MorphemeGrid] Created morpheme with ID: ${result.id}`);
        
        // Success: Update temp ID mapping (keep temp IDs in morpheme objects to avoid re-renders)
        setLocalState(prevState => {
          const newTempIdMap = new Map(prevState.tempIdMap);
          if (!newTempIdMap.has(tempMorphemeId)) {
            newTempIdMap.set(tempMorphemeId, result.id);
            console.log(`[MorphemeGrid] Mapped temp ID ${tempMorphemeId} -> real ID ${result.id}`);
          }
          
          return { 
            ...prevState, 
            tempIdMap: newTempIdMap
          };
        });
      } else {
        console.error(`[MorphemeGrid] API call returned invalid result:`, result);
      }
      
    } catch (error) {
      console.error('[MorphemeGrid] Failed to create morpheme:', error);
    }
  };
  
  // Create multiple morphemes at once with optimistic updates
  const handleCreateMultipleMorphemes = async (wordToken, morphemeData) => {
    console.log(`[MorphemeGrid] handleCreateMultipleMorphemes called - creating ${morphemeData.length} morphemes`, morphemeData);
    
    const tempMorphemes = [];
    
    // Generate temp IDs and create morpheme objects
    morphemeData.forEach((data, index) => {
      const tempId = generateTempId();
      tempMorphemes.push({
        id: tempId,
        text: token.text,
        begin: token.begin,
        end: token.end,
        precedence: data.precedence,
        content: data.form,
        metadata: { form: data.form },
        annotations: {},
        vocabItem: null
      });
    });
    
    // OPTIMISTIC UPDATE: Add morphemes to UI immediately
    updateLocalMorphemes(morphemes => {
      // If this is the first morphemes for this token, replace empty array
      if (morphemes.length === 0) {
        return [...tempMorphemes];
      }
      // Otherwise append to existing morphemes
      const newMorphemes = [...morphemes, ...tempMorphemes];
      return newMorphemes;
    });
    
    // Focus on the second morpheme immediately if we created at least 2
    if (tempMorphemes.length >= 2) {
      setTimeout(() => {
        const secondMorphemeId = tempMorphemes[1].id;
        const morphemeRef = morphemeRefs.current.get(secondMorphemeId);
        if (morphemeRef?.current) {
          console.log(`[MorphemeGrid] Focusing on second temp morpheme: "${tempMorphemes[1].content}"`);
          morphemeRef.current.focus(1); // Position cursor after the "-"
        } else {
          console.log(`[MorphemeGrid] Could not find ref for second morpheme: ${secondMorphemeId}`);
        }
      }, 0);
    }
    
    // BACKGROUND API CALLS
    try {
      console.log(`[MorphemeGrid] Starting API calls for morpheme creation`);
      operations.client.beginBatch();
      
      // Queue up all the create operations (they return undefined during batching)
      for (const data of morphemeData) {
        console.log(`[MorphemeGrid] Batching morpheme creation - precedence: ${data.precedence}, form: "${data.form}", morphemeLayerId: ${morphemeLayerId}`);
        
        operations.client.tokens.create(
          morphemeLayerId,
          token.text,
          token.begin,
          token.end,
          data.precedence,
          data.form ? { form: data.form } : undefined
        );
      }
      
      // Submit batch and get results
      const batchResults = await operations.client.submitBatch();
      console.log(`[MorphemeGrid] Batch results:`, batchResults);
      
      // Extract created morpheme IDs from batch results
      const createdMorphemeIds = [];
      for (let i = 0; i < morphemeData.length; i++) {
        if (batchResults[i] && batchResults[i].body && batchResults[i].body.id) {
          const newId = batchResults[i].body.id;
          createdMorphemeIds.push(newId);
          console.log(`[MorphemeGrid] Created morpheme with ID: ${newId}, form: "${morphemeData[i].form}"`);
        } else {
          console.error(`[MorphemeGrid] Batch result ${i} missing ID:`, batchResults[i]);
          createdMorphemeIds.push(null);
        }
      }
      
      // Success: Update temp ID mappings (keep temp IDs in morpheme objects to avoid re-renders)
      setLocalState(prevState => {
        const newTempIdMap = new Map(prevState.tempIdMap);
        
        tempMorphemes.forEach((tempMorpheme, index) => {
          if (createdMorphemeIds[index] && !newTempIdMap.has(tempMorpheme.id)) {
            const realId = createdMorphemeIds[index];
            console.log(`[MorphemeGrid] Mapping temp ID ${tempMorpheme.id} -> real ID ${realId}`);
            newTempIdMap.set(tempMorpheme.id, realId);
          }
        });
        
        return { 
          ...prevState, 
          tempIdMap: newTempIdMap
        };
      });
      
    } catch (error) {
      console.error('[MorphemeGrid] Failed to create multiple morphemes:', error);
      operations.client.abortBatch();
    }
  };
  
  // Split morpheme with optimistic updates
  const handleSplitMorpheme = async (morpheme, leftForm, rightForm) => {
    console.log(`[MorphemeGrid] handleSplitMorpheme - morpheme.id: ${morpheme.id}, left: "${leftForm}", right: "${rightForm}"`);
    
    const tempMorphemeId = generateTempId();
    const currentIndex = localState.morphemes.findIndex(m => m.id === morpheme.id);
    const rightPrecedence = currentIndex + 2;
    
    // OPTIMISTIC UPDATE: Update UI immediately
    updateLocalMorphemes(morphemes => {
      const newMorphemes = [...morphemes];
      
      // Update existing morpheme's form (create new object)
      const morphemeIndex = newMorphemes.findIndex(m => m.id === morpheme.id);
      if (morphemeIndex >= 0) {
        newMorphemes[morphemeIndex] = {
          ...newMorphemes[morphemeIndex],
          metadata: { ...newMorphemes[morphemeIndex].metadata, form: leftForm }
        };
      }
      
      // Create new morpheme object
      const newMorpheme = {
        id: tempMorphemeId,
        text: token.text,
        begin: token.begin,
        end: token.end,
        precedence: rightPrecedence,
        content: rightForm,
        metadata: { form: rightForm },
        annotations: {},
        vocabItem: null
      };
      
      // Insert new morpheme after current one
      newMorphemes.splice(currentIndex + 1, 0, newMorpheme);
      
      // Update precedences of subsequent morphemes (create new objects)
      for (let i = currentIndex + 2; i < newMorphemes.length; i++) {
        newMorphemes[i] = { ...newMorphemes[i], precedence: i + 1 };
      }
      
      return newMorphemes;
    });
    
    // Focus on the newly created morpheme immediately
    setTimeout(() => {
      const morphemeRef = morphemeRefs.current.get(tempMorphemeId);
      if (morphemeRef?.current) {
        console.log(`[MorphemeGrid] Focusing on split morpheme: "${rightForm}"`);
        morphemeRef.current.focus(1); // Position cursor after the "-"
      }
    }, 0);
    
    // BACKGROUND API CALLS
    try {
      operations.client.beginBatch();
      
      // Get real ID for the morpheme being split
      const morphemeRealId = resolveToRealId(morpheme.id);
      
      if (!morphemeRealId) {
        console.error(`[MorphemeGrid] Cannot split morpheme ${morpheme.id} - no real ID found`);
        return;
      }
      
      // Update existing morpheme's form using real ID
      await operations.client.tokens.setMetadata(morphemeRealId, { form: leftForm });
      
      // Create new morpheme right after the current one
      const newMorpheme = await operations.client.tokens.create(
        morphemeLayerId,
        token.text,
        token.begin,
        token.end,
        rightPrecedence,
        rightForm ? { form: rightForm } : undefined
      );
      
      console.log(`[MorphemeGrid] Created split morpheme with ID: ${newMorpheme?.id}`);
      
      // Update all subsequent morphemes' precedences
      const originalMorphemes = [...localState.morphemes];
      for (let i = currentIndex + 1; i < originalMorphemes.length; i++) {
        const morphemeToUpdate = originalMorphemes[i];
        // Get real ID for subsequent morphemes too
        const updateRealId = resolveToRealId(morphemeToUpdate.id) || morphemeToUpdate.id;
        await operations.client.tokens.update(updateRealId, undefined, undefined, i + 2);
      }
      
      const batchResults = await operations.client.submitBatch();
      
      // Success: Update temp ID mapping if we got an ID from the batch
      if (batchResults && batchResults[1] && batchResults[1].body && batchResults[1].body.id) {
        const newMorphemeId = batchResults[1].body.id;
        setLocalState(prevState => {
          const newTempIdMap = new Map(prevState.tempIdMap);
          if (!newTempIdMap.has(tempMorphemeId)) {
            newTempIdMap.set(tempMorphemeId, newMorphemeId);
            console.log(`[MorphemeGrid] Mapped split temp ID ${tempMorphemeId} -> real ID ${newMorphemeId}`);
          }
          
          return { 
            ...prevState, 
            tempIdMap: newTempIdMap
          };
        });
      }
      
    } catch (error) {
      console.error('[MorphemeGrid] Failed to split morpheme:', error);
      operations.client.abortBatch();
    }
  };
  
  // Delete morpheme with optimistic updates
  const handleDeleteMorpheme = async (morpheme) => {
    console.log(`[MorphemeGrid] handleDeleteMorpheme - morpheme.id: ${morpheme.id}`);
    
    const currentIndex = localState.morphemes.findIndex(m => m.id === morpheme.id);
    const originalMorphemes = [...localState.morphemes];
    
    // OPTIMISTIC UPDATE: Remove morpheme immediately
    updateLocalMorphemes(morphemes => {
      const newMorphemes = [...morphemes];
      
      // Remove the morpheme
      newMorphemes.splice(currentIndex, 1);
      
      // Update precedences of subsequent morphemes
      for (let i = currentIndex; i < newMorphemes.length; i++) {
        newMorphemes[i] = { ...newMorphemes[i], precedence: i + 1 };
      }
      
      return newMorphemes;
    });
    
    // BACKGROUND API CALLS
    try {
      operations.client.beginBatch();
      
      // Get real ID for the morpheme being deleted
      const morphemeRealId = resolveToRealId(morpheme.id);
      
      if (!morphemeRealId) {
        console.error(`[MorphemeGrid] Cannot delete morpheme ${morpheme.id} - no real ID found`);
        return;
      }
      
      // Delete the morpheme using real ID
      await operations.client.tokens.delete(morphemeRealId);
      
      // Immediately mark this ID as deleted to prevent further operations
      deletedIdsRef.current.add(morphemeRealId);
      deletedIdsRef.current.add(morpheme.id); // Also track the temp ID if different
      
      // Clean up temp ID mapping immediately
      if (morpheme.id.startsWith('temp_')) {
        tempIdMapRef.current.delete(morpheme.id);
      }
      
      // Update precedences of all subsequent morphemes
      for (let i = currentIndex + 1; i < originalMorphemes.length; i++) {
        const morphemeToUpdate = originalMorphemes[i];
        // Get real ID for subsequent morphemes too
        const updateRealId = resolveToRealId(morphemeToUpdate.id);
        if (updateRealId) {
          await operations.client.tokens.update(updateRealId, undefined, undefined, i); // New precedence is i (0-based becomes 1-based)
        }
      }
      
      await operations.client.submitBatch();
      
    } catch (error) {
      console.error('[MorphemeGrid] Failed to delete morpheme:', error);
      operations.client.abortBatch();
    }
  };
  
  // Update morpheme form - called on blur only
  const handleUpdateMorphemeForm = async (morpheme, form) => {
    console.log(`[MorphemeGrid] handleUpdateMorphemeForm - morpheme.id: ${morpheme.id}, form: "${form}"`);
    
    // Check if we can resolve this ID to a real one
    const isTemporaryId = morpheme.id.startsWith('temp_');
    const realId = resolveToRealId(morpheme.id);
    
    console.log(`[MorphemeGrid] Debug: isTemporaryId=${isTemporaryId}, realId=${realId}, tempIdMap size=${tempIdMapRef.current.size}`);
    console.log(`[MorphemeGrid] Current tempIdMap:`, Array.from(tempIdMapRef.current.entries()));
    
    if (isTemporaryId && !realId) {
      // Temp ID without real ID yet - revert form to original value
      const originalForm = (morpheme.metadata && 'form' in morpheme.metadata ? morpheme.metadata.form : morpheme.content) || '';
      console.log(`[MorphemeGrid] Reverting form for temp ID ${morpheme.id} from "${form}" back to "${originalForm}" (no real ID mapping yet)`);
      
      // Update local state to revert the form
      updateLocalMorphemes(morphemes => {
        const newMorphemes = [...morphemes];
        const morphemeIndex = newMorphemes.findIndex(m => m.id === morpheme.id);
        if (morphemeIndex >= 0) {
          newMorphemes[morphemeIndex] = {
            ...newMorphemes[morphemeIndex],
            metadata: { ...newMorphemes[morphemeIndex].metadata, form: originalForm }
          };
        }
        return newMorphemes;
      });
      
      // Update the field editor to show the reverted value
      const morphemeRef = morphemeRefs.current.get(morpheme.id);
      if (morphemeRef?.current) {
        morphemeRef.current.setValue(originalForm);
      }
      
      return; // Don't make API call
    }
    
    // Continue with API call using real ID
    const idToUse = realId || morpheme.id;
    console.log(`[MorphemeGrid] Using ID ${idToUse} for form update`);
    
    try {
      // Update morpheme metadata using real ID
      await operations.client.tokens.setMetadata(idToUse, { form });
      
      // Update local state to reflect successful change
      updateLocalMorphemes(morphemes => {
        const newMorphemes = [...morphemes];
        const morphemeIndex = newMorphemes.findIndex(m => m.id === morpheme.id);
        if (morphemeIndex >= 0) {
          newMorphemes[morphemeIndex] = {
            ...newMorphemes[morphemeIndex],
            metadata: { ...newMorphemes[morphemeIndex].metadata, form: form }
          };
        }
        return newMorphemes;
      });
      
    } catch (error) {
      console.error('[MorphemeGrid] Failed to update morpheme form:', error);
      
      // Revert form on API failure
      const originalForm = (morpheme.metadata && 'form' in morpheme.metadata ? morpheme.metadata.form : morpheme.content) || '';
      console.log(`[MorphemeGrid] API failed, reverting form for ${morpheme.id} from "${form}" back to "${originalForm}"`);
      
      const morphemeRef = morphemeRefs.current.get(morpheme.id);
      if (morphemeRef?.current) {
        morphemeRef.current.setValue(originalForm);
      }
    }
  };
  
  // Merge current morpheme with previous morpheme using optimistic updates
  const handleMergeWithPrevious = async (currentMorphemeIndex, currentText) => {
    console.log(`[MorphemeGrid] handleMergeWithPrevious - index: ${currentMorphemeIndex}, currentText: "${currentText}"`);
    
    if (currentMorphemeIndex > 0) {
      const previousMorpheme = localState.morphemes[currentMorphemeIndex - 1];
      const currentMorpheme = localState.morphemes[currentMorphemeIndex];
      
      if (previousMorpheme && currentMorpheme) {
        // Get the previous morpheme's form
        const previousForm = previousMorpheme.vocabItem?.form || 
          (previousMorpheme.metadata && 'form' in previousMorpheme.metadata ? previousMorpheme.metadata.form : previousMorpheme.content) || '';
        const mergedForm = previousForm + currentText;
        const cursorPosition = previousForm.length; // Position at the end of previous content
        
        console.log(`[MorphemeGrid] Merging "${previousForm}" + "${currentText}" = "${mergedForm}", cursor at ${cursorPosition}`);
        
        const originalMorphemes = [...localState.morphemes];
        
        // OPTIMISTIC UPDATE: Merge morphemes immediately
        updateLocalMorphemes(morphemes => {
          const newMorphemes = [...morphemes];
          
          // Update previous morpheme with merged form (create new object)
          const prevMorphemeIndex = newMorphemes.findIndex(m => m.id === previousMorpheme.id);
          if (prevMorphemeIndex >= 0) {
            newMorphemes[prevMorphemeIndex] = {
              ...newMorphemes[prevMorphemeIndex],
              metadata: { ...newMorphemes[prevMorphemeIndex].metadata, form: mergedForm }
            };
          }
          
          // Remove current morpheme
          newMorphemes.splice(currentMorphemeIndex, 1);
          
          // Update precedences of subsequent morphemes (create new objects)
          for (let i = currentMorphemeIndex; i < newMorphemes.length; i++) {
            newMorphemes[i] = { ...newMorphemes[i], precedence: i + 1 };
          }
          
          return newMorphemes;
        });
        
        // Focus on the previous morpheme with cursor at merge point immediately
        setTimeout(() => {
          const morphemeRef = morphemeRefs.current.get(previousMorpheme.id);
          if (morphemeRef?.current) {
            console.log(`[MorphemeGrid] Focusing on merged morpheme with cursor at position ${cursorPosition}`);
            morphemeRef.current.focus(cursorPosition);
          }
        }, 0);
        
        // BACKGROUND API CALLS
        try {
          operations.client.beginBatch();
          
          // Get real IDs for both morphemes
          const previousRealId = resolveToRealId(previousMorpheme.id);
          const currentRealId = resolveToRealId(currentMorpheme.id);
          
          if (!previousRealId || !currentRealId) {
            console.error(`[MorphemeGrid] Cannot merge morphemes - missing real IDs for ${previousMorpheme.id} or ${currentMorpheme.id}`);
            return;
          }
          
          // Update previous morpheme with merged form using real ID
          await operations.client.tokens.setMetadata(previousRealId, { form: mergedForm });
          
          // Delete current morpheme using real ID
          await operations.client.tokens.delete(currentRealId);
          
          // Immediately mark the morpheme as deleted to prevent further operations
          deletedIdsRef.current.add(currentRealId);
          deletedIdsRef.current.add(currentMorpheme.id); // Also track the temp ID if different
          
          // Clean up temp ID mapping immediately
          if (currentMorpheme.id.startsWith('temp_')) {
            tempIdMapRef.current.delete(currentMorpheme.id);
          }
          
          // Update precedences of all subsequent morphemes
          for (let i = currentMorphemeIndex + 1; i < originalMorphemes.length; i++) {
            const morphemeToUpdate = originalMorphemes[i];
            // Get real ID for subsequent morphemes too
            const updateRealId = resolveToRealId(morphemeToUpdate.id);
            if (updateRealId) {
              await operations.client.tokens.update(updateRealId, undefined, undefined, i); // New precedence is i (gap closed)
            }
          }
          
          await operations.client.submitBatch();
          
        } catch (error) {
          console.error('[MorphemeGrid] Failed to merge morphemes:', error);
          operations.client.abortBatch();
        }
      }
    }
  };
  
  // Handle vocabulary operations - optimistically update morpheme's vocabItem
  const handleVocabLinkUpdate = (morpheme, vocabItem) => {
    console.log(`[MorphemeGrid] handleVocabLinkUpdate - morpheme: ${morpheme.id}, vocabItem:`, vocabItem);
    
    // OPTIMISTIC UPDATE: Update morpheme's vocabItem immediately
    updateLocalMorphemes(morphemes => {
      const newMorphemes = [...morphemes];
      const morphemeIndex = newMorphemes.findIndex(m => m.id === morpheme.id);
      
      if (morphemeIndex >= 0) {
        newMorphemes[morphemeIndex] = {
          ...newMorphemes[morphemeIndex],
          vocabItem: vocabItem // This can be null for unlinking
        };
      }
      
      return newMorphemes;
    });
  };

  // Update morpheme span - called on blur only
  const handleUpdateMorphemeSpan = async (morpheme, field, value) => {
    console.log(`[MorphemeGrid] handleUpdateMorphemeSpan - morpheme.id: ${morpheme.id}, field: ${field.name}, value: "${value}"`);
    
    // Check if we can resolve this ID to a real one
    const isTemporaryId = morpheme.id.startsWith('temp_');
    const realId = resolveToRealId(morpheme.id);
    
    console.log(`[MorphemeGrid] Span update debug: isTemporaryId=${isTemporaryId}, realId=${realId}, tempIdMap size=${tempIdMapRef.current.size}`);
    
    if (isTemporaryId && !realId) {
      // Temp ID without real ID yet - revert span to original value
      const originalValue = morpheme.annotations[field.name]?.value || '';
      console.log(`[MorphemeGrid] Reverting span for temp ID ${morpheme.id} from "${value}" back to "${originalValue}" (no real ID mapping yet)`);
      
      // Update local state to revert the span
      updateLocalMorphemes(morphemes => {
        const newMorphemes = [...morphemes];
        const morphemeIndex = newMorphemes.findIndex(m => m.id === morpheme.id);
        if (morphemeIndex >= 0) {
          newMorphemes[morphemeIndex] = {
            ...newMorphemes[morphemeIndex],
            annotations: {
              ...newMorphemes[morphemeIndex].annotations,
              [field.name]: { value: originalValue }
            }
          };
        }
        return newMorphemes;
      });
      
      return; // Don't make API call
    }
    
    // Create a morpheme object with the real ID for the API call
    const morphemeForApi = realId ? { ...morpheme, id: realId } : morpheme;
    console.log(`[MorphemeGrid] Using ID ${morphemeForApi.id} for span update`);
    
    try {
      // Use the existing operations function for span updates
      await operations.updateMorphemeSpan(morphemeForApi, field, value);
      
      // Update local state to reflect successful change
      updateLocalMorphemes(morphemes => {
        const newMorphemes = [...morphemes];
        const morphemeIndex = newMorphemes.findIndex(m => m.id === morpheme.id);
        if (morphemeIndex >= 0) {
          newMorphemes[morphemeIndex] = {
            ...newMorphemes[morphemeIndex],
            annotations: {
              ...newMorphemes[morphemeIndex].annotations,
              [field.name]: { value: value }
            }
          };
        }
        return newMorphemes;
      });
      
    } catch (error) {
      console.error('[MorphemeGrid] Failed to update morpheme span:', error);
      
      // Revert span on API failure
      const originalValue = morpheme.annotations[field.name]?.value || '';
      console.log(`[MorphemeGrid] API failed, reverting span for ${morpheme.id} from "${value}" back to "${originalValue}"`);
    }
  };


  // Don't render if no morpheme fields configured
  if (!morphemeFields || morphemeFields.length === 0) {
    return null;
  }

  return (
    <div className="morpheme-grid-container" ref={gridRef}>
      {/* Existing morpheme columns */}
      {localState.morphemes.map((morpheme, morphemeIndex) => {
        // Create or get ref for this morpheme (handle both temp and real IDs)
        let morphemeRef = morphemeRefs.current.get(morpheme.id);
        if (!morphemeRef) {
          morphemeRef = React.createRef();
          morphemeRefs.current.set(morpheme.id, morphemeRef);
        }
        
        // If this morpheme has a temp ID that maps to a real ID, also map the ref
        const realId = localState.tempIdMap.get(morpheme.id);
        if (realId && !morphemeRefs.current.has(realId)) {
          morphemeRefs.current.set(realId, morphemeRef);
        }
        
        return (
          <MorphemeColumn
            key={morpheme.id}
            ref={morphemeRef}
            morpheme={morpheme}
            morphemeIndex={morphemeIndex}
            morphemeFields={morphemeFields}
            operations={{
              updateMorphemeForm: handleUpdateMorphemeForm,
              updateMorphemeSpan: handleUpdateMorphemeSpan
            }}
            vocabularies={vocabularies}
            readOnly={readOnly}
            wordToken={token}
            getTabIndex={getTabIndex}
            onSplit={handleSplitMorpheme}
            onDelete={handleDeleteMorpheme}
            onMergeWithPrevious={handleMergeWithPrevious}
            onVocabLinkUpdate={handleVocabLinkUpdate}
            fullOperations={operations}
          />
        );
      })}
      
      {/* Placeholder column for creating new morphemes - only show if no morphemes exist */}
      {!readOnly && localState.morphemes.length === 0 && (
        <PlaceholderMorphemeColumn
          morphemeFields={morphemeFields}
          onCreateMorpheme={handleCreateMorpheme}
          onCreateMultipleMorphemes={handleCreateMultipleMorphemes}
          wordToken={token}
          getTabIndex={getTabIndex}
          readOnly={readOnly}
          morphemeCount={localState.morphemes.length}
        />
      )}
    </div>
  );
};