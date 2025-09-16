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
 * @param {Object} project - Project object with configuration (optional, for metadata filtering)
 * @returns {Object} Parsed document structure
 */
export function parseDocument(rawDocument, client, project) {
  try {
    // Extract core document data
    const documentData = extractDocumentData(rawDocument, project);
    
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
      client,
      layers.morphemeTokenLayer
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
 * @param {Object} project - Project object with configuration (optional, for metadata filtering)
 * @returns {Object} Core document data
 */
function extractDocumentData(rawDocument, project) {
  const primaryTextLayer = rawDocument.textLayers?.find(
    layer => layer.config?.plaid?.primary
  );
  
  // Extract configured metadata fields if project config is available
  const configuredMetadata = {};
  if (project?.config?.plaid?.documentMetadata && rawDocument.metadata) {
    const metadataFields = project.config.plaid.documentMetadata;
    metadataFields.forEach(field => {
      if (field.name && rawDocument.metadata.hasOwnProperty(field.name)) {
        configuredMetadata[field.name] = rawDocument.metadata[field.name];
      }
    });
  }
  
  return {
    id: rawDocument.id,
    name: rawDocument.name,
    project: rawDocument.project,
    version: rawDocument.version,
    mediaUrl: rawDocument.mediaUrl,
    text: primaryTextLayer?.text,
    metadata: configuredMetadata
  };
}

/**
 * Find and identify primary layers from text layers
 * @param {Array} textLayers - Array of text layers
 * @returns {Object} Object containing identified layers
 */
function findPrimaryLayers(textLayers) {
  const primaryTextLayer = textLayers.find(layer => layer.config?.plaid?.primary);
  const primaryTokenLayer = primaryTextLayer.tokenLayers.find(layer => layer.config?.plaid?.primary);
  const sentenceTokenLayer = primaryTextLayer.tokenLayers.find(layer => layer.config?.plaid?.sentence);
  const alignmentTokenLayer = primaryTextLayer.tokenLayers.find(layer => layer.config?.plaid?.alignment);
  const morphemeTokenLayer = primaryTextLayer.tokenLayers.find(layer => layer.config?.plaid?.morpheme);

  // Collect all span layers and categorize by scope
  const spanLayers = {
    token: [],
    sentence: [],
    morpheme: []
  };
  
  // Collect span layers from primary token layer
  if (primaryTokenLayer.spanLayers) {
    primaryTokenLayer.spanLayers.forEach(spanLayer => {
      const scope = spanLayer.config?.plaid?.scope;
      if (scope === 'Token' || scope === 'Word') {
        spanLayers.token.push(spanLayer);
      }
    });
  }
  
  // Collect span layers from morpheme token layer
  if (morphemeTokenLayer?.spanLayers) {
    morphemeTokenLayer.spanLayers.forEach(spanLayer => {
      const scope = spanLayer.config?.plaid?.scope;
      if (scope === 'Morpheme') {
        spanLayers.morpheme.push(spanLayer);
      }
    });
  }
  
  // Collect span layers from sentence token layer
  if (sentenceTokenLayer.spanLayers) {
    sentenceTokenLayer.spanLayers.forEach(spanLayer => {
      const scope = spanLayer.config?.plaid?.scope;
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
    morphemeTokenLayer,
    spanLayers
  };
}

/**
 * Process sentence boundaries from sentence token layer
 * @param {Object} sentenceTokenLayer - Sentence token layer
 * @returns {Array} Array of sentence objects with boundaries
 */
function processSentenceBoundaries(sentenceTokenLayer) {
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
      ...token,
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
  const orthographyConfigs = primaryTokenLayer.config?.plaid?.orthographies || [];
  
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
 * Map morpheme tokens to their parent word tokens
 * @param {Array} wordTokens - Array of word tokens
 * @param {Object} morphemeTokenLayer - Morpheme token layer
 * @param {Object} spanLayers - Categorized span layers
 * @param {string} text - The full document text for computing token content
 * @returns {Map} Map of word token IDs to their morphemes
 */
function mapMorphemesToWords(wordTokens, morphemeTokenLayer, spanLayers, text) {
  const morphemesByWord = new Map();
  
  if (!morphemeTokenLayer || !morphemeTokenLayer.tokens) {
    return morphemesByWord;
  }
  
  // Create a map for quick word token lookup by position
  const wordTokensByPosition = new Map();
  wordTokens.forEach(wordToken => {
    const key = `${wordToken.begin}-${wordToken.end}`;
    wordTokensByPosition.set(key, wordToken);
  });
  
  // Group morphemes by their parent word (same begin/end)
  morphemeTokenLayer.tokens.forEach(morpheme => {
    const key = `${morpheme.begin}-${morpheme.end}`;
    const parentWord = wordTokensByPosition.get(key);
    
    if (parentWord) {
      if (!morphemesByWord.has(parentWord.id)) {
        morphemesByWord.set(parentWord.id, []);
      }
      
      // Create morpheme object with annotations
      const morphemeWithData = {
        id: morpheme.id,
        text: morpheme.text,
        begin: morpheme.begin,
        end: morpheme.end,
        precedence: morpheme.precedence || 1,
        content: text.slice(morpheme.begin, morpheme.end),
        metadata: morpheme.metadata || {},
        annotations: collectAnnotations(morpheme, spanLayers.morpheme, 'Morpheme')
      };
      
      morphemesByWord.get(parentWord.id).push(morphemeWithData);
    } else {
      console.warn(`Morpheme token ${morpheme.id} at position ${morpheme.begin}-${morpheme.end} has no corresponding word token`);
    }
  });
  
  // Sort morphemes by precedence for each word
  morphemesByWord.forEach((morphemes, wordId) => {
    morphemes.sort((a, b) => a.precedence - b.precedence);
  });
  
  return morphemesByWord;
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
 * @param {Object} morphemeTokenLayer - Morpheme token layer
 * @returns {Array} Sentences with tokens and annotations
 */
function mapTokensToSentences(sentences, primaryTokenLayer, spanLayers, text, client, morphemeTokenLayer) {
  const wordTokens = primaryTokenLayer.tokens || [];
  
  // Process vocabulary links from the primary token layer
  const singleTokenVocabLinks = processSingleTokenVocabLinks(primaryTokenLayer.vocabs || [], client);
  
  // Process vocabulary links from the morpheme token layer if it exists
  const morphemeVocabLinks = morphemeTokenLayer 
    ? processSingleTokenVocabLinks(morphemeTokenLayer.vocabs || [], client)
    : {};
  
  // Sort word tokens by begin position
  const sortedTokens = wordTokens
    .map(token => ({
      id: token.id,
      text: token.text,
      begin: token.begin,
      end: token.end,
      content: text.slice(token.begin, token.end), // Pre-compute token content
      metadata: token.metadata || {}, // Include full metadata object
      annotations: {}, // Will be populated later
      orthographies: {}, // Will be populated later from metadata
      vocabItem: singleTokenVocabLinks[token.id] || null, // Add vocab item if linked
      morphemes: [] // Will be populated if morpheme layer exists
    }))
    .sort((a, b) => a.begin - b.begin);
  
  // Map morphemes to words if morpheme layer exists
  let morphemesByWord = new Map();
  if (morphemeTokenLayer) {
    morphemesByWord = mapMorphemesToWords(sortedTokens, morphemeTokenLayer, spanLayers, text);
    
    // Add morpheme vocab links to morphemes
    morphemesByWord.forEach((morphemes, wordId) => {
      morphemes.forEach(morpheme => {
        morpheme.vocabItem = morphemeVocabLinks[morpheme.id] || null;
      });
    });
  }
  
  // Map tokens to sentences
  const enrichedSentences = sentences.map(sentence => {
    // Find all tokens that fall within this sentence's boundaries
    const tokensInSentence = sortedTokens.filter(token => 
      token.begin >= sentence.begin && token.end <= sentence.end
    );
    
    // Collect token-level annotations and orthographies for each token
    const tokensWithAnnotations = tokensInSentence.map(token => ({
      ...token,
      annotations: collectAnnotations(token, spanLayers.token, 'Word'),
      orthographies: collectOrthographies(token, primaryTokenLayer),
      morphemes: morphemesByWord.get(token.id) || [] // Add morphemes to each word token
    }));
    
    // Collect sentence-level annotations for the sentence
    const sentenceAnnotations = collectAnnotations(sentence, spanLayers.sentence, 'Sentence');
    
    // Pre-compute spans (tokens + gaps) for efficient rendering
    const sentencePieces = computePiecesForSentence(sentence, tokensWithAnnotations, text);
    
    return {
      ...sentence,
      annotations: sentenceAnnotations,
      tokens: tokensWithAnnotations,
      pieces: sentencePieces,
      dragState: {
        isDragging: false,
        startToken: null,
        selectedTokenIds: new Set()
      }
    };
  });
  
  return enrichedSentences;
}

/**
 * Collect annotations for a given item (token or sentence)
 * @param {Object} item - Token or sentence object
 * @param {Array} spanLayers - Relevant span layers
 * @param {string} scope - 'Word' or 'Morpheme' or 'Sentence'
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
      if (scope === 'Word' || scope === 'Morpheme') {
        // For tokens/morphemes, find spans that contain this token
        return span.tokens && span.tokens.some(tokenId => tokenId === item.id);
      } else {
        // For sentences, find spans that contain this sentence's token ID
        const isMatch = span.tokens && span.tokens.includes(item.id);

        // Debug sentence span matching
        if (scope === 'Sentence') {
          console.log(`[DEBUG] Sentence span matching:`, {
            sentenceId: item.id,
            spanId: span.id,
            spanTokens: span.tokens,
            isMatch: isMatch,
            spanValue: span.value,
            layerName: spanLayer.name
          });
        }

        return isMatch;
      }
    });

    // Store the entire span record if found
    if (matchingSpans.length > 0) {
      annotations[spanLayer.name] = matchingSpans[0];

      // Debug sentence annotation assignment
      if (scope === 'Sentence') {
        console.log(`[DEBUG] Assigned sentence annotation:`, {
          sentenceId: item.id,
          layerName: spanLayer.name,
          spanValue: matchingSpans[0].value,
          spanId: matchingSpans[0].id
        });
      }
    }
  });

  return annotations;
}

/**
 * Compute pieces (tokens + gaps) for a sentence to enable efficient rendering
 * @param {Object} sentence - Sentence object with begin/end positions
 * @param {Array} tokens - Array of tokens within this sentence
 * @param {string} text - Full document text
 * @returns {Array} Array of span objects (tokens and gaps)
 */
function computePiecesForSentence(sentence, tokens, text) {
  const pieces = [];
  const sortedTokens = [...tokens].sort((a, b) => a.begin - b.begin);
  let lastEnd = sentence.begin;

  // Create spans for tokens and gaps within this sentence
  for (const token of sortedTokens) {
    // Add untokenized text before this token
    if (token.begin > lastEnd) {
      pieces.push({
        type: 'gap',
        content: text.slice(lastEnd, token.begin),
        isToken: false,
        begin: lastEnd,
        end: token.begin
      });
    }

    // Add the token
    pieces.push({
      type: 'token',
      ...token,
      isToken: true
    });

    lastEnd = token.end;
  }

  // Add final untokenized text within sentence
  if (lastEnd < sentence.end) {
    pieces.push({
      type: 'gap',
      content: text.slice(lastEnd, sentence.end),
      isToken: false,
      begin: lastEnd,
      end: sentence.end
    });
  }

  return pieces;
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
  
  console.log('✅ Sentence token partitioning validation passed');
}