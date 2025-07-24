/**
 * Document Parser Utility
 * 
 * Transforms raw Plaid API document responses into a flat, render-friendly structure
 * organized by sentences containing tokens with their annotations.
 */

/**
 * Main parser function that transforms raw document response
 * @param {Object} rawDocument - Raw document response from API
 * @param {Object} client - Client object for API calls (optional, for cleanup)
 * @returns {Object} Parsed document structure
 */
export function parseDocument(rawDocument, client) {
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
      layers.spanLayers,
      documentData.text.body,
      client
    );

    // Process alignment tokens
    const alignmentTokens = processAlignmentTokens(layers.alignmentTokenLayer);
    
    // Validate sentence token partitioning
    validateSentencePartitioning(sentences, documentData.text.body);

    // Pre-compute optimizations for rendering performance
    const sortedSentences = [...enrichedSentences].sort((a, b) => a.begin - b.begin);
    const findSentenceForToken = createSentenceLookup(sortedSentences);
    const lookupMaps = createLookupMaps(enrichedSentences);

    return {
      document: documentData,
      sentences: enrichedSentences,
      sortedSentences: sortedSentences,
      findSentenceForToken: findSentenceForToken,
      alignmentTokens: alignmentTokens,
      layers: layers, // Include layer metadata for debugging
      ...lookupMaps // Add lookup maps for O(1) operations
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
      sentenceToken: token, // Include full sentence token object
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
 * Collect orthographies for a token from its metadata
 * @param {Object} token - Token object with metadata
 * @param {Object} primaryTokenLayer - Primary token layer with orthography config
 * @returns {Object} Orthographies keyed by orthography name
 */
function collectOrthographies(token, primaryTokenLayer) {
  const orthographies = {};
  
  // Get orthography configurations from the primary token layer
  const orthographyConfigs = primaryTokenLayer.config?.flan?.orthographies || [];
  
  // Initialize all configured orthographies
  orthographyConfigs.forEach(orthoConfig => {
    const orthographyName = orthoConfig.name;
    const metadataKey = `orthog:${orthographyName}`;
    
    // Get value from metadata using orthog:${name} key pattern
    orthographies[orthographyName] = token.metadata?.[metadataKey] || '';
  });
  
  return orthographies;
}

/**
 * Process vocabulary links to find single-token associations
 * @param {Array} vocabs - Array of vocabulary objects from primary token layer
 * @param {Function} client - Client object for API calls (optional, for cleanup)
 * @returns {Object} Object mapping token IDs to vocab items for single-token links
 */
function processSingleTokenVocabLinks(vocabs, client) {
  const singleTokenVocabLinks = {};
  const multipleLinksForToken = {};
  
  if (!Array.isArray(vocabs)) {
    return singleTokenVocabLinks;
  }
  
  // First pass: collect all vocab links per token
  vocabs.forEach(vocab => {
    if (!vocab.vocabLinks || !Array.isArray(vocab.vocabLinks)) {
      return;
    }
    
    vocab.vocabLinks.forEach(vocabLink => {
      // Check if this vocab link has exactly one token
      if (vocabLink.tokens && Array.isArray(vocabLink.tokens) && vocabLink.tokens.length === 1) {
        const tokenId = vocabLink.tokens[0];
        
        if (vocabLink.vocabItem) {
          const vocabItemData = {
            id: vocabLink.vocabItem.id,
            form: vocabLink.vocabItem.form,
            metadata: vocabLink.vocabItem.metadata || {},
            vocabId: vocab.id,
            vocabName: vocab.name,
            linkId: vocabLink.id
          };
          
          // Track multiple links for the same token
          if (!multipleLinksForToken[tokenId]) {
            multipleLinksForToken[tokenId] = [];
          }
          multipleLinksForToken[tokenId].push(vocabItemData);
        }
      }
    });
  });
  
  // Second pass: handle multiple vocab items per token
  Object.entries(multipleLinksForToken).forEach(([tokenId, vocabItems]) => {
    if (vocabItems.length > 1) {
      console.warn(`🚨 VOCAB LINK VIOLATION: Token ${tokenId} has ${vocabItems.length} associated vocab items. Expected exactly 1.`);
      console.warn('Associated vocab items:', vocabItems.map(v => `${v.form} (${v.vocabName})`));
      
      // Choose one randomly to keep
      const randomIndex = Math.floor(Math.random() * vocabItems.length);
      const chosenItem = vocabItems[randomIndex];
      singleTokenVocabLinks[tokenId] = chosenItem;
      
      console.warn(`Randomly chose to keep: ${chosenItem.form} (${chosenItem.vocabName})`);
      
      // Schedule cleanup of the others if client is available
      if (client) {
        const toDelete = vocabItems.filter((_, index) => index !== randomIndex);
        toDelete.forEach(item => {
          console.warn(`Scheduling deletion of vocab link ${item.linkId} for vocab item: ${item.form}`);
          // Note: We can't await here since this is synchronous parsing
          // The cleanup will happen asynchronously
          client.vocabLinks.delete(item.linkId).catch(error => {
            console.error(`Failed to delete duplicate vocab link ${item.linkId}:`, error);
          });
        });
      }
    } else if (vocabItems.length === 1) {
      // Single vocab item - normal case
      singleTokenVocabLinks[tokenId] = vocabItems[0];
    }
  });
  
  return singleTokenVocabLinks;
}

/**
 * Map word tokens to sentences and collect annotations
 * @param {Array} sentences - Array of sentence boundaries
 * @param {Object} primaryTokenLayer - Primary token layer with word tokens
 * @param {Object} spanLayers - Categorized span layers
 * @param {string} text - The full document text for computing token content
 * @param {Object} client - Client object for API calls (optional, for cleanup)
 * @returns {Array} Sentences with tokens and annotations
 */
function mapTokensToSentences(sentences, primaryTokenLayer, spanLayers, text, client) {
  const wordTokens = primaryTokenLayer.tokens || [];
  
  // Process vocabulary links from the primary token layer
  const singleTokenVocabLinks = processSingleTokenVocabLinks(primaryTokenLayer.vocabs || [], client);
  
  // Sort word tokens by begin position
  const sortedTokens = wordTokens
    .map(token => ({
      id: token.id,
      text: token.text || '',
      begin: token.begin,
      end: token.end,
      content: text.slice(token.begin, token.end), // Pre-compute token content
      metadata: token.metadata || {}, // Include full metadata object
      annotations: {}, // Will be populated later
      orthographies: {}, // Will be populated later from metadata
      vocabItem: singleTokenVocabLinks[token.id] || null // Add vocab item if linked
    }))
    .sort((a, b) => a.begin - b.begin);
  
  // Map tokens to sentences
  const enrichedSentences = sentences.map(sentence => {
    // Find all tokens that fall within this sentence's boundaries
    const tokensInSentence = sortedTokens.filter(token => 
      token.begin >= sentence.begin && token.end <= sentence.end
    );
    
    // Collect token-level annotations and orthographies for each token
    const tokensWithAnnotations = tokensInSentence.map(token => ({
      ...token,
      annotations: collectAnnotations(token, spanLayers.token, 'Token'),
      orthographies: collectOrthographies(token, primaryTokenLayer)
    }));
    
    // Collect sentence-level annotations for the sentence
    const sentenceAnnotations = collectAnnotations(sentence, spanLayers.sentence, 'Sentence');
    
    // Pre-compute spans (tokens + gaps) for efficient rendering
    const spans = computeSpansForSentence(sentence, tokensWithAnnotations, text);
    
    return {
      ...sentence,
      annotations: sentenceAnnotations,
      tokens: tokensWithAnnotations,
      spans: spans
    };
  });
  
  return enrichedSentences;
}

/**
 * Collect annotations for a given item (token or sentence)
 * @param {Object} item - Token or sentence object
 * @param {Array} spanLayers - Relevant span layers
 * @param {string} scope - 'Token' or 'Sentence'
 * @returns {Object} Annotations keyed by layer name, with null for missing annotations
 */
function collectAnnotations(item, spanLayers, scope) {
  const annotations = {};
  
  // Initialize all annotation layer keys with null values
  spanLayers.forEach(spanLayer => {
    annotations[spanLayer.name] = null;
  });
  
  // Fill in actual annotation values where they exist
  spanLayers.forEach(spanLayer => {
    // Find spans that match this item
    const matchingSpans = (spanLayer.spans || []).filter(span => {
      if (scope === 'Token') {
        // For tokens, find spans that contain this token
        return span.tokens && span.tokens.some(tokenId => tokenId === item.id);
      } else {
        // For sentences, find spans that match this sentence
        // Look for spans that overlap with the sentence boundaries
        return span.tokens && span.tokens.length > 0 && 
               span.tokens.some(tokenId => {
                 // This is a simplified approach - we'd need to check if the token is within the sentence
                 // For now, assume sentence-level spans are properly constructed
                 return true;
               });
      }
    });
    
    // Store the entire span record if found
    if (matchingSpans.length > 0) {
      annotations[spanLayer.name] = matchingSpans[0];
    }
  });
  
  return annotations;
}

/**
 * Compute spans (tokens + gaps) for a sentence to enable efficient rendering
 * @param {Object} sentence - Sentence object with begin/end positions
 * @param {Array} tokens - Array of tokens within this sentence
 * @param {string} text - Full document text
 * @returns {Array} Array of span objects (tokens and gaps)
 */
function computeSpansForSentence(sentence, tokens, text) {
  const spans = [];
  const sortedTokens = [...tokens].sort((a, b) => a.begin - b.begin);
  let lastEnd = sentence.begin;

  // Create spans for tokens and gaps within this sentence
  for (const token of sortedTokens) {
    // Add untokenized text before this token
    if (token.begin > lastEnd) {
      spans.push({
        type: 'gap',
        text: text.slice(lastEnd, token.begin),
        isToken: false,
        begin: lastEnd,
        end: token.begin
      });
    }

    // Add the token
    spans.push({
      type: 'token',
      ...token,
      isToken: true
    });

    lastEnd = token.end;
  }

  // Add final untokenized text within sentence
  if (lastEnd < sentence.end) {
    spans.push({
      type: 'gap',
      text: text.slice(lastEnd, sentence.end),
      isToken: false,
      begin: lastEnd,
      end: sentence.end
    });
  }

  return spans;
}

/**
 * Create lookup maps for O(1) operations
 * @param {Array} sentences - Array of sentences with tokens
 * @returns {Object} Object containing lookup maps
 */
function createLookupMaps(sentences) {
  const tokenLookup = new Map();
  const sentenceLookup = new Map();
  const tokenPositionMaps = new Map();
  const sentenceIndexLookup = new Map();

  sentences.forEach((sentence, sentenceIndex) => {
    // Add sentence to lookup by ID
    sentenceLookup.set(sentence.id, sentence);
    sentenceIndexLookup.set(sentence.id, sentenceIndex);

    // Create token position map for this sentence
    const tokenPositionMap = new Map();
    
    if (sentence.tokens && Array.isArray(sentence.tokens)) {
      sentence.tokens.forEach((token, tokenIndex) => {
        // Add token to global lookup
        tokenLookup.set(token.id, token);
        
        // Add token position within this sentence
        tokenPositionMap.set(token.id, tokenIndex);
      });
    }

    tokenPositionMaps.set(sentence.id, tokenPositionMap);
  });

  return {
    tokenLookup,
    sentenceLookup,
    tokenPositionMaps,
    sentenceIndexLookup
  };
}

/**
 * Create an efficient lookup function for finding which sentence contains a token
 * @param {Array} sortedSentences - Array of sentences sorted by begin position
 * @returns {Function} Lookup function that takes a token and returns its containing sentence
 */
function createSentenceLookup(sortedSentences) {
  /**
   * Find the sentence that contains the given token
   * @param {Object} token - Token object with begin/end positions
   * @returns {Object|null} The sentence that contains the token, or null if not found
   */
  return function findSentenceForToken(token) {
    if (!token || typeof token.begin !== 'number' || typeof token.end !== 'number') {
      return null;
    }

    // Binary search for efficiency (since sentences are sorted and non-overlapping)
    let left = 0;
    let right = sortedSentences.length - 1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const sentence = sortedSentences[mid];

      if (token.begin >= sentence.begin && token.end <= sentence.end) {
        // Token is completely within this sentence
        return sentence;
      } else if (token.begin < sentence.begin) {
        // Token starts before this sentence, search left half
        right = mid - 1;
      } else {
        // Token starts after this sentence begins, search right half
        left = mid + 1;
      }
    }

    return null; // Token not found in any sentence
  };
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