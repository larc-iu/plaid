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
    
    const [id, form, lemma, upos, xpos, feats, head, deprel, _deps, misc] = columns;
    
    // Initialize sentence if needed
    if (!currentSentence) {
      currentSentence = {
        tokens: [],
        multiWordTokens: [],
        metadata: {}
      };
    }
    
    // Skip ellipsis tokens (e.g., "4.1"). The UD format uses decimal IDs for
    // empty nodes (enhanced dependencies) which we don't currently model — warn
    // so round-trip data loss is visible to the user.
    if (id.includes('.')) {
      console.warn(`Dropping CoNLL-U ellipsis token (decimal ID): ${id} — empty nodes are not preserved on round-trip`);
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
 * Build the sentence > word > morpheme hierarchy with global character offsets
 * from parsed CoNLL-U data, for import into the three-layer token model.
 *
 * - Sentences tile the reconstructed text [0, len) gap-free; the newline that
 *   separates two sentences belongs to the preceding sentence.
 * - Each surface token becomes a WORD: a multiword token (range id) spans its
 *   member rows; an ordinary integer row is a 1:1 word.
 * - Each integer-id row becomes a MORPHEME that inhabits the FULL width of its
 *   word (MWT components all share the word's extent, ordered by precedence).
 *
 * Returns:
 *   {
 *     text,                       // reconstructed document body
 *     sentences: [{
 *       begin, end, metadata,
 *       words: [{
 *         begin, end, isMwt, surfaceForm,
 *         morphemes: [{ begin, end, precedence, row }]   // row = the parsed integer-id token
 *       }]
 *     }]
 *   }
 */
export function buildConlluHierarchy(parsedData) {
  // Group a sentence's integer-id rows into surface units (words). A multiword
  // token covers its member rows; every other row is its own 1:1 unit.
  const surfaceUnitsForSentence = (sentence) => {
    const mwtByStart = new Map();
    (sentence.multiWordTokens || []).forEach(m => mwtByStart.set(m.start, m));

    const units = [];
    const rows = sentence.tokens;
    let i = 0;
    while (i < rows.length) {
      const mwt = mwtByStart.get(rows[i].id);
      if (mwt && mwt.end > mwt.start) {
        const startIdx = mwt.start - 1;
        const endIdx = mwt.end - 1;
        const members = rows.slice(startIdx, endIdx + 1);
        // Track whether the MWT row explicitly carried a non-underscore FORM.
        // If it didn't, we still need *some* `surfaceForm` to place the unit
        // (locateUnits' indexOf needs a non-empty string), so we fall back to
        // joining member forms — but the importer must NOT persist this
        // synthetic value on `metadata.form`. `hasExplicitForm` distinguishes
        // these cases for downstream consumers.
        const hasExplicitForm = Boolean(mwt.form);
        const surfaceForm = hasExplicitForm
          ? mwt.form
          : members.map(r => r.form).filter(Boolean).join('');
        units.push({
          surfaceForm,
          hasExplicitForm,
          isMwt: true,
          members,
          misc: mwt.misc || null
        });
        i = endIdx + 1;
      } else {
        units.push({ surfaceForm: rows[i].form, hasExplicitForm: false, isMwt: false, members: [rows[i]], misc: null });
        i += 1;
      }
    }
    return units;
  };

  // Locate each surface unit's [begin, end] within its sentence text.
  // When a unit's form can't be located (e.g. CJK / no-space scripts where
  // `# text = ...` doesn't contain the literal form, or when the metadata text
  // is missing), fall back to a deterministic, gap-free synthetic placement:
  // begin = previous.end, end = begin + form.length. This preserves the
  // Words-in-Sentence tiling invariant even though offsets won't match the
  // original text. We warn so the user knows the offsets are synthetic.
  const locateUnits = (sentenceText, units) => {
    const positions = [];
    let searchPos = 0;
    let warnedSyntheticOffsets = false;
    for (const unit of units) {
      const form = unit.surfaceForm || '';
      const idx = form ? sentenceText.indexOf(form, searchPos) : -1;
      if (idx === -1) {
        if (!warnedSyntheticOffsets) {
          console.warn(
            `CoNLL-U import: could not locate form "${form}" in sentence text; ` +
            `using synthetic gap-free offsets for this sentence (positions will not match the original text).`
          );
          warnedSyntheticOffsets = true;
        }
        const begin = positions.length === 0 ? 0 : positions[positions.length - 1].end;
        positions.push({ begin, end: begin + form.length });
        searchPos = begin + form.length;
      } else {
        positions.push({ begin: idx, end: idx + form.length });
        searchPos = idx + form.length;
      }
    }
    return positions;
  };

  let text = '';
  const sentences = [];

  parsedData.sentences.forEach((sentence, sentIdx) => {
    const units = surfaceUnitsForSentence(sentence);
    const rawSentenceText = (sentence.metadata && sentence.metadata.text)
      ? sentence.metadata.text
      : units.map(u => u.surfaceForm).join(' ');

    const unitPositions = locateUnits(rawSentenceText, units);
    // The synthetic-offset fallback can place a unit past
    // `rawSentenceText.length` when cumulative form lengths exceed the
    // metadata text. Pad the body with spaces so the words still tile inside
    // their sentence — otherwise the server's nesting constraint rejects the
    // word bulk-create.
    const maxEnd = unitPositions.reduce((acc, p) => Math.max(acc, p.end), 0);
    const overflowed = maxEnd > rawSentenceText.length;
    const sentenceText = overflowed
      ? rawSentenceText + ' '.repeat(maxEnd - rawSentenceText.length)
      : rawSentenceText;
    // When we had to pad, the body no longer matches the `# text =`
    // metadata. Drop the stored `text` key so the exporter falls back to
    // the (padded) body substring, then trims — round-trip yields the
    // original visible text without a body/metadata mismatch.
    const sentenceMetadata = sentence.metadata || {};
    const finalMetadata = overflowed && 'text' in sentenceMetadata
      ? Object.fromEntries(Object.entries(sentenceMetadata).filter(([k]) => k !== 'text'))
      : sentenceMetadata;

    const sentenceStart = text.length;
    text += sentenceText;
    const isLast = sentIdx === parsedData.sentences.length - 1;
    if (!isLast) text += '\n';
    const sentenceEnd = text.length; // includes the trailing newline for non-last sentences

    const words = units.map((unit, unitIdx) => {
      const begin = sentenceStart + unitPositions[unitIdx].begin;
      const end = sentenceStart + unitPositions[unitIdx].end;
      const morphemes = unit.members.map((row, mi) => ({ begin, end, precedence: mi, row }));
      return {
        begin,
        end,
        isMwt: unit.isMwt,
        hasExplicitForm: unit.hasExplicitForm,
        surfaceForm: unit.surfaceForm,
        morphemes,
        misc: unit.misc
      };
    });

    sentences.push({
      begin: sentenceStart,
      end: sentenceEnd,
      metadata: finalMetadata,
      words
    });
  });

  return { text, sentences };
}