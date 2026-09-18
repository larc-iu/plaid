import React from 'react';

// The words of a sentence as columns, with the gloss lines beneath. A line
// with one item per word is laid under the words column by column; any other
// line (morpheme lines, the free translation) runs as a row of its own below,
// since whitespace splitting cannot say which word a morpheme belongs to.
export const TokenRow = React.memo(function TokenRow({
  sentence,
  wordRef,
  anchoredWordIds,
  highlightedWordIds,
  direction,
}) {
  const words = sentence.words;
  const perWord = (sentence.ilg || []).filter((line) => line.items.length === words.length);
  const rows = (sentence.ilg || []).filter((line) => line.items.length !== words.length);
  return (
    <div className="umr-tokens" dir={direction}>
      <div className="umr-word-row">
        {words.map((w, i) => (
          <div
            key={w.id}
            ref={wordRef(w.id)}
            className={[
              'umr-word',
              anchoredWordIds?.has(w.id) ? 'umr-word--anchored' : '',
              highlightedWordIds?.has(w.id) ? 'umr-word--lit' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            data-word-id={w.id}
          >
            <span className="umr-word-index">{i + 1}</span>
            <span className="umr-word-text" dir="auto">
              {w.text}
            </span>
            {perWord.map((line, li) => (
              <span key={li} className="umr-word-gloss" dir="auto" title={line.header}>
                {line.items[i]}
              </span>
            ))}
          </div>
        ))}
      </div>
      {rows.map((line, li) => (
        <div key={li} className="umr-ilg-row">
          <span className="umr-ilg-header">{line.header}</span>
          <span className="umr-ilg-items" dir="auto">
            {line.items.join(' ')}
          </span>
        </div>
      ))}
    </div>
  );
});
