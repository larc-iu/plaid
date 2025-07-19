/**
 * Document Parser Utility
 * 
 * Transforms raw Plaid API document responses into a flat, render-friendly structure
 * organized by sentences containing tokens with their annotations.
 */

/**
 * Main parser function that transforms raw document response
 * @param {Object} rawDocument - Raw document response from API
 * @returns {Object} Parsed document structure
 */
export function parseDocument(rawDocument) {
  try {
    // Extract core document data
    const documentData = extractDocumentData(rawDocument);
    
    // Find and validate required layers
    const layers = findPrimaryLayers(rawDocument.textLayers);
    
    // Process sentence boundaries
    const sentences = processSentenceBoundaries(layers.sentenceTokenLayer);
    
    // Map tokens to sentences and collect annotations
    const enrichedSentences = mapTokensToSentences(
      sentences,
      layers.primaryTokenLayer,
      layers.spanLayers
    );

    // Process alignment tokens
    const alignmentTokens = processAlignmentTokens(layers.alignmentTokenLayer);
    
    // Validate sentence token partitioning
    validateSentencePartitioning(sentences, documentData.text.body);
    
    return {
      document: documentData,
      sentences: enrichedSentences,
      alignmentTokens: alignmentTokens,
      layers: layers // Include layer metadata for debugging
    };
  } catch (error) {
    console.error('Document parsing failed:', error);
    throw new Error(`Failed to parse document: ${error.message}`);
  }
}

/**
 * Extract core document information
 * @param {Object} rawDocument - Raw document response
 * @returns {Object} Core document data
 */
function extractDocumentData(rawDocument) {
  const primaryTextLayer = rawDocument.textLayers?.find(
    layer => layer.config?.flan?.primary
  );
  
  return {
    id: rawDocument.id,
    name: rawDocument.name,
    project: rawDocument.project,
    version: rawDocument.version,
    mediaUrl: rawDocument.mediaUrl,
    text: primaryTextLayer?.text
  };
}

/**
 * Find and identify primary layers from text layers
 * @param {Array} textLayers - Array of text layers
 * @returns {Object} Object containing identified layers
 */
function findPrimaryLayers(textLayers) {
  if (!textLayers || !Array.isArray(textLayers)) {
    throw new Error('No text layers found in document');
  }
  
  // Find primary text layer
  const primaryTextLayer = textLayers.find(
    layer => layer.config?.flan?.primary
  );
  
  if (!primaryTextLayer) {
    throw new Error('No primary text layer found');
  }
  
  if (!primaryTextLayer.tokenLayers || !Array.isArray(primaryTextLayer.tokenLayers)) {
    throw new Error('No token layers found in primary text layer');
  }
  
  // Find primary token layer (contains word tokens)
  const primaryTokenLayer = primaryTextLayer.tokenLayers.find(
    layer => layer.config?.flan?.primary
  );
  
  // Find sentence token layer (contains sentence boundaries)
  const sentenceTokenLayer = primaryTextLayer.tokenLayers.find(
    layer => layer.config?.flan?.sentence
  );

  // Find alignment token layer (contains time-aligned tokens)
  const alignmentTokenLayer = primaryTextLayer.tokenLayers.find(
    layer => layer.config?.flan?.alignment
  );
  
  if (!primaryTokenLayer) {
    throw new Error('No primary token layer found');
  }
  
  if (!sentenceTokenLayer) {
    throw new Error('No sentence token layer found');
  }
  
  // Collect all span layers and categorize by scope
  const spanLayers = {
    token: [],
    sentence: []
  };
  
  // Collect span layers from primary token layer
  if (primaryTokenLayer.spanLayers) {
    primaryTokenLayer.spanLayers.forEach(spanLayer => {
      const scope = spanLayer.config?.flan?.scope;
      if (scope === 'Token') {
        spanLayers.token.push(spanLayer);
      }
    });
  }
  
  // Collect span layers from sentence token layer
  if (sentenceTokenLayer.spanLayers) {
    sentenceTokenLayer.spanLayers.forEach(spanLayer => {
      const scope = spanLayer.config?.flan?.scope;
      if (scope === 'Sentence') {
        spanLayers.sentence.push(spanLayer);
      }
    });
  }
  
  return {
    primaryTextLayer,
    primaryTokenLayer,
    sentenceTokenLayer,
    alignmentTokenLayer,
    spanLayers
  };
}

/**
 * Process sentence boundaries from sentence token layer
 * @param {Object} sentenceTokenLayer - Sentence token layer
 * @returns {Array} Array of sentence objects with boundaries
 */
function processSentenceBoundaries(sentenceTokenLayer) {
  if (!sentenceTokenLayer.tokens || !Array.isArray(sentenceTokenLayer.tokens)) {
    console.warn('No sentence tokens found, creating empty sentences array');
    return [];
  }
  
  // Extract sentence tokens and sort by begin position
  const sentences = sentenceTokenLayer.tokens
    .map(token => ({
      id: token.id,
      text: token.text || '',
      begin: token.begin,
      end: token.end,
      annotations: {} // Will be populated later
    }))
    .sort((a, b) => a.begin - b.begin);
  
  return sentences;
}

/**
 * Process alignment tokens from alignment token layer
 * @param {Object} alignmentTokenLayer - Alignment token layer
 * @returns {Array} Array of alignment token objects with time metadata
 */
function processAlignmentTokens(alignmentTokenLayer) {
  if (!alignmentTokenLayer || !alignmentTokenLayer.tokens || !Array.isArray(alignmentTokenLayer.tokens)) {
    console.warn('No alignment tokens found, creating empty alignment tokens array');
    return [];
  }
  
  // Extract alignment tokens and sort by begin position
  const alignmentTokens = alignmentTokenLayer.tokens
    .map(token => ({
      ...token, // Pass through all token data including metadata
      annotations: {} // Will be populated later if needed
    }))
    .sort((a, b) => a.begin - b.begin);
  
  return alignmentTokens;
}

/**
 * Map word tokens to sentences and collect annotations
 * @param {Array} sentences - Array of sentence boundaries
 * @param {Object} primaryTokenLayer - Primary token layer with word tokens
 * @param {Object} spanLayers - Categorized span layers
 * @returns {Array} Sentences with tokens and annotations
 */
function mapTokensToSentences(sentences, primaryTokenLayer, spanLayers) {
  const wordTokens = primaryTokenLayer.tokens || [];
  
  // Sort word tokens by begin position
  const sortedTokens = wordTokens
    .map(token => ({
      id: token.id,
      text: token.text || '',
      begin: token.begin,
      end: token.end,
      annotations: {} // Will be populated later
    }))
    .sort((a, b) => a.begin - b.begin);
  
  // Map tokens to sentences
  const enrichedSentences = sentences.map(sentence => {
    // Find all tokens that fall within this sentence's boundaries
    const tokensInSentence = sortedTokens.filter(token => 
      token.begin >= sentence.begin && token.end <= sentence.end
    );
    
    // Collect token-level annotations for each token
    const tokensWithAnnotations = tokensInSentence.map(token => ({
      ...token,
      annotations: collectAnnotations(token, spanLayers.token, 'Token')
    }));
    
    // Collect sentence-level annotations for the sentence
    const sentenceAnnotations = collectAnnotations(sentence, spanLayers.sentence, 'Sentence');
    
    return {
      ...sentence,
      annotations: sentenceAnnotations,
      tokens: tokensWithAnnotations
    };
  });
  
  return enrichedSentences;
}

/**
 * Collect annotations for a given item (token or sentence)
 * @param {Object} item - Token or sentence object
 * @param {Array} spanLayers - Relevant span layers
 * @param {string} scope - 'Token' or 'Sentence'
 * @returns {Object} Annotations keyed by layer name
 */
function collectAnnotations(item, spanLayers, scope) {
  const annotations = {};
  
  spanLayers.forEach(spanLayer => {
    // Find spans that match this item
    const matchingSpans = (spanLayer.spans || []).filter(span => {
      if (scope === 'Token') {
        // For tokens, find spans that contain this token
        return span.tokens && span.tokens.some(tokenId => tokenId === item.id);
      } else {
        // For sentences, find spans that match this sentence
        // This might need adjustment based on how sentence spans are structured
        return span.begin >= item.begin && span.end <= item.end;
      }
    });
    
    // Store the annotation value(s)
    if (matchingSpans.length > 0) {
      // If multiple spans, take the first one or combine them
      annotations[spanLayer.name] = matchingSpans[0].value || '';
    }
  });
  
  return annotations;
}

/**
 * Validate that sentence tokens properly partition the text
 * @param {Array} sentences - Array of sentence boundaries
 * @param {string} text - Full text content
 * @throws {Error} If partitioning is invalid
 */
function validateSentencePartitioning(sentences, text) {
  if (!text || typeof text !== 'string') {
    console.warn('No text content to validate sentence partitioning against');
    return;
  }
  
  if (!sentences || sentences.length === 0) {
    console.warn('No sentences to validate partitioning for');
    return;
  }
  
  // Sort sentences by begin position
  const sortedSentences = [...sentences].sort((a, b) => a.begin - b.begin);
  
  // Check that sentences start at 0
  if (sortedSentences[0].begin !== 0) {
    console.warn(`🚨 SENTENCE PARTITIONING VIOLATION: First sentence does not start at position 0! Expected: 0, Actual: ${sortedSentences[0].begin}`);
  }
  
  // Check that sentences end at text length
  const lastSentence = sortedSentences[sortedSentences.length - 1];
  if (lastSentence.end !== text.length) {
    console.warn(`🚨 SENTENCE PARTITIONING VIOLATION: Last sentence does not end at text length! Expected: ${text.length}, Actual: ${lastSentence.end}`);
  }
  
  // Check for gaps and overlaps
  for (let i = 0; i < sortedSentences.length - 1; i++) {
    const currentSentence = sortedSentences[i];
    const nextSentence = sortedSentences[i + 1];
    
    if (currentSentence.end !== nextSentence.begin) {
      console.warn(`🚨 SENTENCE PARTITIONING VIOLATION: Gap or overlap detected between sentences ${i + 1} and ${i + 2}! Sentence ${i + 1} ends at ${currentSentence.end}, but sentence ${i + 2} starts at ${nextSentence.begin}`);
      console.warn('Current sentence:', currentSentence);
      console.warn('Next sentence:', nextSentence);
    }
  }
  
  // Check for any sentence with invalid boundaries
  for (let i = 0; i < sortedSentences.length; i++) {
    const sentence = sortedSentences[i];
    
    if (sentence.begin < 0 || sentence.end < 0) {
      console.warn(`🚨 SENTENCE PARTITIONING VIOLATION: Sentence ${i + 1} has negative boundaries! Begin: ${sentence.begin}, End: ${sentence.end}`);
    }
    
    if (sentence.begin >= sentence.end) {
      console.warn(`🚨 SENTENCE PARTITIONING VIOLATION: Sentence ${i + 1} has invalid boundaries! Begin: ${sentence.begin}, End: ${sentence.end}`);
    }
    
    if (sentence.end > text.length) {
      console.warn(`🚨 SENTENCE PARTITIONING VIOLATION: Sentence ${i + 1} extends beyond text length! End: ${sentence.end}, Text length: ${text.length}`);
    }
  }
  
  console.log('✅ Sentence token partitioning validation passed');
}

/**
 * Validate that a parsed document has the expected structure
 * @param {Object} parsedDocument - Parsed document object
 * @returns {boolean} True if valid
 */
export function validateParsedDocument(parsedDocument) {
  try {
    if (!parsedDocument.document || !parsedDocument.document.id) {
      throw new Error('Missing document data');
    }
    
    if (!Array.isArray(parsedDocument.sentences)) {
      throw new Error('Sentences must be an array');
    }

    if (!Array.isArray(parsedDocument.alignmentTokens)) {
      throw new Error('Alignment tokens must be an array');
    }
    
    // Validate each sentence structure
    parsedDocument.sentences.forEach((sentence, index) => {
      if (!sentence.id || typeof sentence.begin !== 'number' || typeof sentence.end !== 'number') {
        throw new Error(`Invalid sentence structure at index ${index}`);
      }
      
      if (!Array.isArray(sentence.tokens)) {
        throw new Error(`Sentence tokens must be an array at index ${index}`);
      }
      
      // Validate each token structure
      sentence.tokens.forEach((token, tokenIndex) => {
        if (!token.id || typeof token.begin !== 'number' || typeof token.end !== 'number') {
          throw new Error(`Invalid token structure at sentence ${index}, token ${tokenIndex}`);
        }
      });
    });
    
    return true;
  } catch (error) {
    console.error('Document validation failed:', error);
    return false;
  }
}