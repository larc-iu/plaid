import React from 'react';
import { HEADERS, morphemeJoinersFor } from '../../../domain/ilg.js';

// The words of a sentence as columns, with the gloss lines beneath. A line
// that can be told word by word (ilg.js) is laid under the words column by
// column; any other line (the free translation, a line nothing groups) runs
// as a row of its own below. Every line's name sits in the margin to its
// left, level with it, so the lines themselves start where the words do.
//
// The MORPHEME lines of a word share one grid, a column per morpheme, so a
// morpheme's form sits above its gloss and its category the way an
// interlinear text is read and the way plaid-igt's grid draws it. They are
// contiguous because ilg.js sorts the lines by scope, and each grid row keeps
// the same line height as an ordinary line so the names in the margin stay
// level with what they name.
export const TokenRow = React.memo(function TokenRow({
  sentence,
  wordRef,
  anchoredWordIds,
  highlightedWordIds,
  dropWordId,
  direction,
  onWordClick,
  onWordDoubleClick,
  pickingWords = false,
}) {
  const words = sentence.words;
  const perWord = (sentence.ilg || []).filter((line) => line.perWord);
  // Runs of adjacent lines, so a word's morpheme lines can be drawn as one
  // grid and everything else stays a line of its own.
  const blocks = groupByScope(perWord);
  // The joint before each morpheme, '-' or '=' by its morph type, as
  // plaid-igt's grid draws it. Display only: a file writes the forms bare.
  const joiners = morphemeJoinersFor(sentence);
  // A line with nothing on it carries nothing, and the export drops it too.
  const rows = (sentence.ilg || []).filter((line) => !line.perWord && line.items.length);
  return (
    <div className={`umr-tokens${pickingWords ? ' umr-tokens--pick' : ''}`} dir={direction}>
      <div className="umr-word-row">
        {perWord.length > 0 && (
          <div className="umr-legend" aria-hidden="true">
            <span className="umr-legend-index">&nbsp;</span>
            <span className="umr-legend-word">&nbsp;</span>
            {perWord.map((line, li) => (
              <span key={li} className="umr-tier-label">
                {line.header}
              </span>
            ))}
          </div>
        )}
        {words.map((w, i) => (
          <div
            key={w.id}
            ref={wordRef(w.id)}
            className={[
              'umr-word',
              anchoredWordIds?.has(w.id) ? 'umr-word--anchored' : '',
              highlightedWordIds?.has(w.id) ? 'umr-word--lit' : '',
              dropWordId === w.id ? 'umr-word--drop' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            data-word-id={w.id}
            onClick={onWordClick ? () => onWordClick(w.id) : undefined}
            onDoubleClick={onWordDoubleClick ? () => onWordDoubleClick(w.id) : undefined}
          >
            <span className="umr-word-index">{i + 1}</span>
            <span className="umr-word-text" dir="auto">
              {w.text}
            </span>
            {blocks.map((block, bi) =>
              block.morpheme ? (
                <div key={bi} className="umr-morphemes">
                  {Array.from({ length: columnsOf(block, i) }, (_, ci) => (
                    <React.Fragment key={ci}>
                      {ci > 0 && (
                        <span className="umr-morph-joiner" aria-hidden="true">
                          {joiners[i]?.[ci] || '-'}
                        </span>
                      )}
                      <div className="umr-morph-col">
                        {block.lines.map((line) => (
                          <span
                            key={line.key}
                            className={`umr-word-gloss${
                              line.key === 'morphemes' ? ' umr-morph-form' : ''
                            }`}
                            dir="auto"
                            title={line.header}
                          >
                            {line.perWord[i][ci] ?? ''}
                          </span>
                        ))}
                      </div>
                    </React.Fragment>
                  ))}
                </div>
              ) : (
                block.lines.map((line) => (
                  <span key={line.key} className="umr-word-gloss" dir="auto" title={line.header}>
                    {line.perWord[i].join(' ')}
                  </span>
                ))
              ),
            )}
          </div>
        ))}
      </div>
      {rows.map((line, li) => (
        <div key={li} className="umr-ilg-row">
          <span className="umr-ilg-header umr-tier-label">{line.header}</span>
          <span className="umr-ilg-items" dir="auto">
            {line.items.join(' ')}
          </span>
        </div>
      ))}
    </div>
  );
});

const MORPHEME_KEYS = new Set(HEADERS.filter((h) => h.scope === 'morpheme').map((h) => h.key));

// Adjacent lines of the same kind as one block. Only a run of morpheme lines
// is drawn as a grid; everything else keeps a line each.
const groupByScope = (lines) => {
  const blocks = [];
  lines.forEach((line) => {
    const morpheme = MORPHEME_KEYS.has(line.key);
    const last = blocks[blocks.length - 1];
    if (last && last.morpheme === morpheme) last.lines.push(line);
    else blocks.push({ morpheme, lines: [line] });
  });
  return blocks;
};

// How many columns one word needs: the longest of its morpheme lines. They
// are the same length in a healthy document, and a line that is short (an
// import that glossed fewer morphemes than the word has) is padded rather
// than left to slide its neighbours across.
const columnsOf = (block, wordIndex) =>
  Math.max(1, ...block.lines.map((line) => line.perWord[wordIndex].length));
