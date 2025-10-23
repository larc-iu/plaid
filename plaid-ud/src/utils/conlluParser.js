/**
 * Parse CoNLL-U format text into structured data
 * Filters out ellipsis tokens (IDs like "4.1") but captures multi-word tokens (IDs like "1-3")
 */

export function parseCoNLLU(text) {
  const lines = text.split('\n');
  const sentences = [];
  let currentSentence = null;
  let currentMetadata = {};
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    
    // Skip empty lines between sentences
    if (trimmedLine === '') {
      if (currentSentence && currentSentence.tokens.length > 0) {
        currentSentence.metadata = currentMetadata;
        // Ensure multiWordTokens array exists even if no MWTs were found
        if (!currentSentence.multiWordTokens) {
          currentSentence.multiWordTokens = [];
        }
        sentences.push(currentSentence);
        currentSentence = null;
        currentMetadata = {};
      }
      continue;
    }
    
    // Handle metadata lines
    if (trimmedLine.startsWith('#')) {
      // Skip newdoc id and sent_id as requested
      if (trimmedLine.startsWith('# newdoc id') || trimmedLine.startsWith('# sent_id')) {
        continue;
      }
      
      // Parse other metadata
      const metadataMatch = trimmedLine.match(/^#\s*([^=]+?)\s*=\s*(.+)$/);
      if (metadataMatch) {
        const [, key, value] = metadataMatch;
        currentMetadata[key.trim()] = value.trim();
      } else {
        // Handle metadata without = sign
        const cleanedLine = trimmedLine.substring(1).trim();
        if (cleanedLine) {
          currentMetadata[cleanedLine] = true;
        }
      }
      continue;
    }
    
    // Parse token lines
    const columns = trimmedLine.split('\t');
    if (columns.length !== 10) {
      throw new Error(`Invalid CoNLL-U format: Expected 10 columns, found ${columns.length} in line: ${trimmedLine}`);
    }
    
    const [id, form, lemma, upos, xpos, feats, head, deprel, deps, misc] = columns;
    
    // Initialize sentence if needed
    if (!currentSentence) {
      currentSentence = {
        tokens: [],
        multiWordTokens: [],
        metadata: {}
      };
    }
    
    // Skip ellipsis tokens (e.g., "4.1")
    if (id.includes('.')) {
      continue;
    }
    
    // Handle multi-word tokens (e.g., "1-3")
    if (id.includes('-')) {
      const [startStr, endStr] = id.split('-');
      const start = parseInt(startStr);
      const end = parseInt(endStr);
      
      if (isNaN(start) || isNaN(end) || start <= 0 || end <= 0 || start >= end) {
        throw new Error(`Invalid multi-word token range: ${id}`);
      }
      
      currentSentence.multiWordTokens.push({
        start: start,
        end: end,
        form: form === '_' ? '' : form,
        misc: misc === '_' ? null : misc
      });
      continue;
    }
    
    // Validate ID is a positive integer
    const idNum = parseInt(id);
    if (isNaN(idNum) || idNum <= 0) {
      throw new Error(`Invalid token ID: ${id}`);
    }
    
    // Parse features into array
    const featuresArray = feats === '_' ? [] : feats.split('|');
    
    // Parse HEAD (0 means root)
    const headNum = head === '_' ? 0 : parseInt(head);
    if (isNaN(headNum) || headNum < 0) {
      throw new Error(`Invalid HEAD value: ${head}`);
    }
    
    // Add token to current sentence
    currentSentence.tokens.push({
      id: idNum,
      form: form === '_' ? '' : form,
      lemma: lemma === '_' ? null : lemma,
      upos: upos === '_' ? null : upos,
      xpos: xpos === '_' ? null : xpos,
      feats: featuresArray,
      head: headNum,
      deprel: deprel === '_' ? null : deprel
    });
  }
  
  // Add last sentence if exists
  if (currentSentence && currentSentence.tokens.length > 0) {
    currentSentence.metadata = currentMetadata;
    // Ensure multiWordTokens array exists even if no MWTs were found
    if (!currentSentence.multiWordTokens) {
      currentSentence.multiWordTokens = [];
    }
    sentences.push(currentSentence);
  }
  
  // Validate that tokens are properly ordered within sentences
  for (const sentence of sentences) {
    const sortedIds = sentence.tokens.map(t => t.id).sort((a, b) => a - b);
    for (let i = 0; i < sortedIds.length; i++) {
      if (sortedIds[i] !== i + 1) {
        throw new Error(`Invalid token ordering: expected continuous IDs starting from 1`);
      }
    }
  }
  
  return { sentences };
}

/**
 * Reconstruct text from parsed CoNLL-U data
 * Each sentence on a new line, tokens space-separated
 */
export function reconstructText(parsedData) {
  return parsedData.sentences
    .map(sentence => {
      // Prefer # text metadata if available
      if (sentence.metadata && sentence.metadata.text) {
        return sentence.metadata.text;
      }
      // Fallback to concatenating token forms
      return sentence.tokens.map(token => token.form).join(' ');
    })
    .join('\n');
}

/**
 * Calculate token positions in reconstructed text
 * Returns array of { begin, end } for each token
 */
export function calculateTokenPositions(parsedData, reconstructedText) {
  const positions = [];
  const sentences = reconstructedText.split('\n');
  let globalPos = 0;
  
  for (let sentIdx = 0; sentIdx < parsedData.sentences.length; sentIdx++) {
    const sentence = parsedData.sentences[sentIdx];
    const sentenceText = sentences[sentIdx] || '';
    const sentencePositions = [];
    
    let searchPos = 0;
    
    for (let i = 0; i < sentence.tokens.length; i++) {
      const token = sentence.tokens[i];
      const tokenForm = token.form;
      
      // Find the token in the sentence text starting from searchPos
      const tokenStart = sentenceText.indexOf(tokenForm, searchPos);
      
      if (tokenStart === -1) {
        // Fallback: if token not found, use simple space-separated positioning
        const beforeTokens = sentence.tokens.slice(0, i).map(t => t.form).join(' ');
        const tokenBegin = globalPos + (beforeTokens ? beforeTokens.length + 1 : 0);
        const tokenEnd = tokenBegin + tokenForm.length;
        
        sentencePositions.push({
          begin: tokenBegin,
          end: tokenEnd
        });
      } else {
        // Token found: use actual position
        sentencePositions.push({
          begin: globalPos + tokenStart,
          end: globalPos + tokenStart + tokenForm.length
        });
        
        // Update search position for next token
        searchPos = tokenStart + tokenForm.length;
      }
    }
    
    positions.push(sentencePositions);
    
    // Update global position for next sentence
    globalPos += sentenceText.length;
    
    // Add newline after sentence (except last sentence)
    if (sentIdx < parsedData.sentences.length - 1) {
      globalPos += 1;
    }
  }
  
  return positions;
}