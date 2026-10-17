/**
 * Tokenization Utilities
 *
 * Provides functions for automatic tokenization of text into words and sentences
 * while respecting ignored tokens configuration.
 *
 * All offsets (begin/end) are 0-based Unicode CODE POINTS, matching Plaid's
 * canonical token-offset unit. JS strings are UTF-16, so we iterate/measure in
 * code points (Array.from / cpLength / cpSlice / utf16ToCp) rather than `[i]` /
 * `.length` / `.slice`, which would mis-place tokens around astral characters.
 */

import { cpSlice, cpLength, utf16ToCp } from '@larc-iu/plaid-client';
import {
  isUnicodePunctuation,
  isWordSpace,
  shouldTokenizeCharacter,
} from '@ui/domain/igtWordBreaks.js';
import {
  findBaselineTextLayer,
  findWordTokenLayer,
  readIgnoredTokens,
} from '../domain/igtConfig.js';

// The break rule is shared with other apps (plaid-ui domain/igtWordBreaks.js).
export { isUnicodePunctuation };

/**
 * Check if a character is whitespace: JavaScript's `\s` and NEL (shared
 * with plaid-ud's gap fill, plaid-ui igtWordBreaks.js)
 * @param {string} char - Single character to check
 * @returns {boolean} True if character is whitespace
 */
const isWhitespace = isWordSpace;

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
        end: token.begin,
      });
    }
    lastEnd = Math.max(lastEnd, token.end);
  }

  // Add final gap if text extends beyond last token
  const len = cpLength(text);
  if (lastEnd < len) {
    ranges.push({
      start: lastEnd,
      end: len,
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
  // Index by code point: ranges/offsets are code points, so cps[i] is the i-th
  // code point (not a UTF-16 unit / surrogate half).
  const cps = Array.from(text);

  for (const range of untokenizedRanges) {
    let currentStart = range.start;
    let i = range.start;

    while (i < range.end) {
      const char = cps[i];
      const shouldBreak = isWhitespace(char) || shouldTokenizeCharacter(char, config);

      if (shouldBreak) {
        // Create token for accumulated text
        if (i > currentStart) {
          const tokenText = cps.slice(currentStart, i).join('');
          const trimmed = tokenText.trim();
          if (trimmed.length > 0) {
            // Find the actual start and end positions of the trimmed text
            const leadingSpaces = tokenText.length - tokenText.trimStart().length;
            const trailingSpaces = tokenText.length - tokenText.trimEnd().length;
            tokens.push({
              text: trimmed,
              begin: currentStart + leadingSpaces,
              end: i - trailingSpaces,
            });
          }
        }

        // Ignored break chars (punctuation, or blacklisted chars per the
        // ignored-tokens config) are NOT emitted as tokens — they're left in
        // the gap between word tokens, matching the .fwbackup import
        // convention. They render identically to a punctuation token anyway
        // (gaps and ignored tokens both go through _inertCol in the Analyze
        // island), so this is a pure data-model cleanup: no junk
        // non-annotatable tokens, and a run like "..." stays one gap instead
        // of three throwaway tokens. Whitelisted punctuation never reaches
        // this branch (shouldTokenizeCharacter returns false), so it still
        // stays inside its word.

        // Skip to next non-whitespace character
        i++;
        while (i < range.end && isWhitespace(cps[i])) {
          i++;
        }
        currentStart = i;
      } else {
        i++;
      }
    }

    // Handle final token in range
    if (currentStart < range.end) {
      const tokenText = cps.slice(currentStart, range.end).join('');
      const trimmed = tokenText.trim();
      if (trimmed.length > 0) {
        // Find the actual start and end positions of the trimmed text
        const leadingSpaces = tokenText.length - tokenText.trimStart().length;
        const trailingSpaces = tokenText.length - tokenText.trimEnd().length;
        tokens.push({
          text: trimmed,
          begin: currentStart + leadingSpaces,
          end: range.end - trailingSpaces,
        });
      }
    }
  }

  return tokens;
}

/**
 * One sentence per line, as a cover of the whole text in code-point offsets:
 * each sentence runs from the first character of its line to the first
 * character of the next non-blank line, so blank lines and indentation belong
 * to the sentence before them and the partition has no gaps. The importers
 * and the bundled tokenizer service produce the same shape.
 * @param {string} text
 * @returns {Array<{begin: number, end: number}>}
 */
export function lineSentenceRanges(text) {
  if (!text) return [];
  const starts = [0]; // UTF-16 indices, converted once at the end
  const lineBreak = /\n\s*/g;
  let match;
  while ((match = lineBreak.exec(text)) !== null) {
    const next = match.index + match[0].length;
    if (next >= text.length) break; // only whitespace follows
    // A line that is all whitespace belongs to the sentence before it.
    if (text.slice(starts[starts.length - 1], match.index).trim() === '') continue;
    starts.push(next);
  }
  return starts.map((start, i) => ({
    begin: utf16ToCp(text, start),
    end: i + 1 < starts.length ? utf16ToCp(text, starts[i + 1]) : cpLength(text),
  }));
}

/**
 * Get ignored tokens configuration from project layers
 * @param {Object} project - Project object with text layers
 * @returns {Object|null} Ignored tokens configuration or null if not found
 */
export function getIgnoredTokensConfig(project) {
  const primaryTextLayer = findBaselineTextLayer(project?.textLayers);
  const primaryTokenLayer = findWordTokenLayer(primaryTextLayer?.tokenLayers);
  return readIgnoredTokens(primaryTokenLayer?.config);
}

/**
 * Validate tokenization results
 * @param {Array} tokens - Array of token objects
 * @param {string} text - Original text
 * @returns {Object} Validation result with isValid boolean and errors array
 */
export function validateTokenization(tokens, text) {
  const errors = [];

  // Overlap is enforced server-side by the word token layer's :non-overlapping mode.
  // We only check out-of-bounds and text-mismatch here.
  const len = cpLength(text);
  tokens.forEach((token, index) => {
    if (token.begin < 0 || token.end > len) {
      errors.push(`Token ${index} out of bounds: ${token.begin}-${token.end}`);
    }

    if (token.begin >= token.end) {
      errors.push(`Invalid token range at ${index}: ${token.begin}-${token.end}`);
    }

    const expectedText = cpSlice(text, token.begin, token.end);
    if (token.text !== expectedText) {
      errors.push(
        `Token text mismatch at ${index}: expected "${expectedText}", got "${token.text}"`,
      );
    }
  });

  return {
    isValid: errors.length === 0,
    errors,
  };
}
