/**
 * Tokenization Utilities
 * 
 * Provides functions for automatic tokenization of text into words and sentences
 * while respecting ignored tokens configuration.
 */

/**
 * Check if a character is Unicode punctuation (category "P")
 * @param {string} char - Single character to check
 * @returns {boolean} True if character is punctuation
 */
export function isUnicodePunctuation(char) {
  if (!char || char.length !== 1) return false;
  
  // Unicode punctuation categories: Pc, Pd, Pe, Pf, Pi, Po, Ps
  const punctuationRegex = /[\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E\u00A1-\u00A9\u00AB-\u00B1\u00B4\u00B6-\u00B8\u00BB\u00BF\u037E\u0387\u055A-\u055F\u0589-\u058A\u05BE\u05C0\u05C3\u05C6\u05F3-\u05F4\u0609-\u060A\u060C-\u060D\u061B\u061E-\u061F\u066A-\u066D\u06D4\u0700-\u070D\u07F7-\u07F9\u0830-\u083E\u085E\u0964-\u0965\u0970\u09FD\u0A76\u0AF0\u0C77\u0C84\u0DF4\u0E4F\u0E5A-\u0E5B\u0F04-\u0F12\u0F14\u0F3A-\u0F3D\u0F85\u0FD0-\u0FD4\u0FD9-\u0FDA\u104A-\u104F\u10FB\u1360-\u1368\u1400\u166E\u169B-\u169C\u16EB-\u16ED\u1735-\u1736\u17D4-\u17D6\u17D8-\u17DA\u1800-\u180A\u1944-\u1945\u1A1E-\u1A1F\u1AA0-\u1AA6\u1AA8-\u1AAD\u1B5A-\u1B60\u1BFC-\u1BFF\u1C3B-\u1C3F\u1C7E-\u1C7F\u1CC0-\u1CC7\u1CD3\u2010-\u2027\u2030-\u2043\u2045-\u2051\u2053-\u205E\u207D-\u207E\u208D-\u208E\u2308-\u230B\u2329-\u232A\u2768-\u2775\u27C5-\u27C6\u27E6-\u27EF\u2983-\u2998\u29D8-\u29DB\u29FC-\u29FD\u2CF9-\u2CFC\u2CFE-\u2CFF\u2D70\u2E00-\u2E2E\u2E30-\u2E4F\u2E52-\u2E5D\u3001-\u3003\u3008-\u3011\u3014-\u301F\u3030\u303D\u30A0\u30FB\uA4FE-\uA4FF\uA60D-\uA60F\uA673\uA67E\uA6F2-\uA6F7\uA874-\uA877\uA8CE-\uA8CF\uA8F8-\uA8FA\uA8FC\uA92E-\uA92F\uA95F\uA9C1-\uA9CD\uA9DE-\uA9DF\uAA5C-\uAA5F\uAADE-\uAADF\uAAF0-\uAAF1\uABEB\uFD3E-\uFD3F\uFE10-\uFE19\uFE30-\uFE52\uFE54-\uFE61\uFE63\uFE68\uFE6A-\uFE6B\uFF01-\uFF03\uFF05-\uFF0A\uFF0C-\uFF0F\uFF1A-\uFF1B\uFF1F-\uFF20\uFF3B-\uFF3D\uFF3F\uFF5B\uFF5D\uFF5F-\uFF65\u{10100}-\u{10102}\u{1039F}\u{103D0}\u{1056F}\u{10857}\u{1091F}\u{1093F}\u{10A50}-\u{10A58}\u{10A7F}\u{10AF0}-\u{10AF6}\u{10B39}-\u{10B3F}\u{10B99}-\u{10B9C}\u{10F55}-\u{10F59}\u{11047}-\u{1104D}\u{110BB}-\u{110BC}\u{110BE}-\u{110C1}\u{11140}-\u{11143}\u{11174}-\u{11175}\u{111C5}-\u{111C8}\u{111C9}\u{111DD}\u{111DB}\u{111DA}\u{11238}-\u{1123D}\u{112A9}\u{1144B}-\u{1144F}\u{1145A}-\u{1145B}\u{1145D}\u{114C6}\u{115C1}-\u{115D7}\u{11641}-\u{11643}\u{11660}-\u{1166C}\u{1173C}-\u{1173E}\u{1183B}\u{11944}-\u{11946}\u{119E2}\u{11A3F}-\u{11A46}\u{11A9A}-\u{11A9C}\u{11A9E}-\u{11AA2}\u{11C41}-\u{11C45}\u{11C70}-\u{11C71}\u{11EF7}-\u{11EF8}\u{12470}-\u{12474}\u{16A6E}-\u{16A6F}\u{16AF5}\u{16B37}-\u{16B3B}\u{16B44}\u{16E97}-\u{16E9A}\u{1BC9F}\u{1DA87}-\u{1DA8B}\u{1E95E}-\u{1E95F}]/u;
  
  return punctuationRegex.test(char);
}

/**
 * Check if a character is whitespace
 * @param {string} char - Single character to check
 * @returns {boolean} True if character is whitespace
 */
export function isWhitespace(char) {
  return /\s/.test(char);
}

/**
 * Determine if a character should cause tokenization based on ignored tokens config
 * @param {string} char - Single character to check
 * @param {Object} config - Ignored tokens configuration
 * @returns {boolean} True if character should cause token boundary
 */
export function shouldTokenizeCharacter(char, config) {
  if (!config) return isUnicodePunctuation(char);
  
  if (config.type === 'unicodePunctuation') {
    // If it's punctuation, check if it's in the whitelist (exceptions)
    if (isUnicodePunctuation(char)) {
      return !config.whitelist?.includes(char);
    }
    return false;
  } else if (config.type === 'blacklist') {
    // Explicit blacklist mode - tokenize on characters in the blacklist
    return config.blacklist?.includes(char) || false;
  }
  
  return isUnicodePunctuation(char);
}

/**
 * Find ranges of text that are not covered by existing tokens
 * @param {string} text - Full text content
 * @param {Array} existingTokens - Array of existing token objects with begin/end
 * @returns {Array} Array of {start, end} ranges that need tokenization
 */
export function findUntokenizedRanges(text, existingTokens = []) {
  if (!text) return [];
  
  const ranges = [];
  const sortedTokens = [...existingTokens].sort((a, b) => a.begin - b.begin);
  
  let lastEnd = 0;
  
  for (const token of sortedTokens) {
    // Add gap before this token
    if (token.begin > lastEnd) {
      ranges.push({
        start: lastEnd,
        end: token.begin
      });
    }
    lastEnd = Math.max(lastEnd, token.end);
  }
  
  // Add final gap if text extends beyond last token
  if (lastEnd < text.length) {
    ranges.push({
      start: lastEnd,
      end: text.length
    });
  }
  
  return ranges;
}

/**
 * Tokenize text within specified ranges, respecting ignored tokens configuration
 * @param {string} text - Full text content
 * @param {Object} config - Ignored tokens configuration
 * @param {Array} untokenizedRanges - Ranges to tokenize
 * @returns {Array} Array of token objects with text, begin, end properties
 */
export function tokenizeText(text, config, untokenizedRanges) {
  const tokens = [];
  
  for (const range of untokenizedRanges) {
    let currentStart = range.start;
    let i = range.start;
    
    while (i < range.end) {
      const char = text[i];
      const shouldBreak = isWhitespace(char) || shouldTokenizeCharacter(char, config);
      
      if (shouldBreak) {
        // Create token for accumulated text
        if (i > currentStart) {
          const tokenText = text.slice(currentStart, i);
          const trimmed = tokenText.trim();
          if (trimmed.length > 0) {
            // Find the actual start and end positions of the trimmed text
            const leadingSpaces = tokenText.length - tokenText.trimStart().length;
            const trailingSpaces = tokenText.length - tokenText.trimEnd().length;
            tokens.push({
              text: trimmed,
              begin: currentStart + leadingSpaces,
              end: i - trailingSpaces
            });
          }
        }
        
        // Skip whitespace, but create token for non-whitespace punctuation
        if (!isWhitespace(char)) {
          tokens.push({
            text: char,
            begin: i,
            end: i + 1
          });
        }
        
        // Skip to next non-whitespace character
        i++;
        while (i < range.end && isWhitespace(text[i])) {
          i++;
        }
        currentStart = i;
      } else {
        i++;
      }
    }
    
    // Handle final token in range
    if (currentStart < range.end) {
      const tokenText = text.slice(currentStart, range.end);
      const trimmed = tokenText.trim();
      if (trimmed.length > 0) {
        // Find the actual start and end positions of the trimmed text
        const leadingSpaces = tokenText.length - tokenText.trimStart().length;
        const trailingSpaces = tokenText.length - tokenText.trimEnd().length;
        tokens.push({
          text: trimmed,
          begin: currentStart + leadingSpaces,
          end: range.end - trailingSpaces
        });
      }
    }
  }
  
  return tokens;
}

/**
 * Tokenize text into sentences, treating newline + whitespace as boundaries
 * @param {string} text - Full text content
 * @param {Array} existingSentenceTokens - Existing sentence tokens
 * @returns {Array} Array of sentence token objects
 */
export function tokenizeSentences(text, existingSentenceTokens = []) {
  if (!text) return [];
  
  const sentences = [];
  
  // Find untokenized ranges for sentences
  const untokenizedRanges = findUntokenizedRanges(text, existingSentenceTokens);
  
  for (const range of untokenizedRanges) {
    const substring = text.slice(range.start, range.end);
    
    // Split on newline followed by optional whitespace
    const sentenceRegex = /\n\s*/g;
    let lastEnd = 0;
    let match;
    
    while ((match = sentenceRegex.exec(substring)) !== null) {
      if (match.index > lastEnd) {
        const sentenceText = substring.slice(lastEnd, match.index);
        if (sentenceText.trim().length > 0) {
          sentences.push({
            text: sentenceText,
            begin: range.start + lastEnd,
            end: range.start + match.index
          });
        }
      }
      lastEnd = match.index + match[0].length;
    }
    
    // Handle final sentence in range
    if (lastEnd < substring.length) {
      const sentenceText = substring.slice(lastEnd);
      if (sentenceText.trim().length > 0) {
        sentences.push({
          text: sentenceText,
          begin: range.start + lastEnd,
          end: range.end
        });
      }
    }
  }
  
  return sentences;
}

/**
 * Get ignored tokens configuration from project layers
 * @param {Object} project - Project object with text layers
 * @returns {Object|null} Ignored tokens configuration or null if not found
 */
export function getIgnoredTokensConfig(project) {
  const primaryTextLayer = project?.textLayers?.find(
    layer => layer.config?.plaid?.primary
  );
  
  const primaryTokenLayer = primaryTextLayer?.tokenLayers?.find(
    layer => layer.config?.plaid?.primary
  );
  
  return primaryTokenLayer?.config?.plaid?.ignoredTokens || null;
}

/**
 * Validate tokenization results
 * @param {Array} tokens - Array of token objects
 * @param {string} text - Original text
 * @returns {Object} Validation result with isValid boolean and errors array
 */
export function validateTokenization(tokens, text) {
  const errors = [];
  
  // Check for overlapping tokens
  const sortedTokens = [...tokens].sort((a, b) => a.begin - b.begin);
  for (let i = 0; i < sortedTokens.length - 1; i++) {
    const current = sortedTokens[i];
    const next = sortedTokens[i + 1];
    
    if (current.end > next.begin) {
      errors.push(`Overlapping tokens: "${current.text}" and "${next.text}"`);
    }
  }
  
  // Check for out-of-bounds tokens
  tokens.forEach((token, index) => {
    if (token.begin < 0 || token.end > text.length) {
      errors.push(`Token ${index} out of bounds: ${token.begin}-${token.end}`);
    }
    
    if (token.begin >= token.end) {
      errors.push(`Invalid token range at ${index}: ${token.begin}-${token.end}`);
    }
    
    const expectedText = text.slice(token.begin, token.end);
    if (token.text !== expectedText) {
      errors.push(`Token text mismatch at ${index}: expected "${expectedText}", got "${token.text}"`);
    }
  });
  
  return {
    isValid: errors.length === 0,
    errors
  };
}