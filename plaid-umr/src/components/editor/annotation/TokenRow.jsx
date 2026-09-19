import React from 'react';

// The words of a sentence as columns, with the gloss lines beneath. A line
// that can be told word by word (ilg.js) is laid under the words column by
// column; any other line (the free translation, a line nothing groups) runs
// as a row of its own below. Every line's name sits in the margin to its
// left, level with it, so the lines themselves start where the words do.
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
            {perWord.map((line, li) => (
              <span key={li} className="umr-word-gloss" dir="auto" title={line.header}>
                {line.perWord[i].join(' ')}
              </span>
            ))}
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
