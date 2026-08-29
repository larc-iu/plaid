// One word's analysis rendered exactly the way the Analyze tab renders a word
// column: the gray word-form band with its lexicon-link hint, the word-level
// annotation cells, then the morpheme chain (forms with affix joiners, each
// with its own link hint and morpheme-level cells). Same class names, same
// stylesheet, read-only — so what the Bulk Edit tab shows is what the editor
// will show once the analysis is applied.
//
// `analysis` is the extractAnalysis shape ({ word: { vocabItemId, fields },
// morphemes: [{ form, morphType, vocabItemId, fields }] }); null renders the
// word as the editor renders an unanalyzed one (bare form, empty cells).

import '@/components/documents/analyze/island/igt-editor.css';
import { cn } from '@/lib/utils';
import { morphemeJoiner, isStemType } from '@/domain/affixMarkers';

// Mirror of IgtEditor._fieldSize: the cross-browser fallback for field-sizing.
const fieldSize = (v) => Math.max(5, [...(v ?? '')].length + 1);

const Field = ({ value, className = '', label }) => {
  const v = value ?? '';
  const filled = v !== '';
  return (
    <input
      className={cn('igt-field', filled ? 'igt-field--filled' : 'igt-field--empty', className)}
      value={v}
      readOnly
      disabled
      size={fieldSize(v)}
      title={filled ? v : undefined}
      aria-label={label}
    />
  );
};

// The link hint under a form (the linked entry's form, dotted-underlined), as
// the editor's _vocabFace renders it, minus the popover.
const Hint = ({ itemId, itemFormById }) => {
  if (!itemId) return null;
  const form = itemFormById?.get(itemId) ?? '?';
  return (
    <button
      type="button"
      className="igt-vocab__opener igt-vocab__hint"
      disabled
      title={`Linked to "${form}"`}
    >
      {form}
    </button>
  );
};

export const AnalysisCard = ({ word, analysis, rows, itemFormById, labels = true }) => {
  const { wordFields, morphFields, hasMorphemes, hasVocabs } = rows;
  const morphemes = analysis?.morphemes?.length
    ? analysis.morphemes
    : [{ form: word, morphType: null, vocabItemId: null, fields: {} }];

  const label = (cls, name, scope) => (
    <div key={`${scope}:${name}`} className={cn('igt-row-label', cls)} title={`${name} (${scope})`}>
      <span className="igt-row-label__text">{name}</span>
    </div>
  );

  return (
    <div
      className={cn('igt-island igt-island--readonly', hasVocabs && 'igt-island--vocab')}
      style={{ width: 'auto' }}
    >
      <div className="igt-grid">
        <div className="igt-tokens">
          {labels && (
            <div className="igt-labels">
              <div className="igt-row-label igt-row-label--spacer" />
              {wordFields.map((n) => label('igt-row-label--word', n, 'word'))}
              {hasMorphemes &&
                label('igt-row-label--morph igt-row-label--morphform', 'Morphemes', 'morpheme')}
              {hasMorphemes && morphFields.map((n) => label('igt-row-label--morph', n, 'morpheme'))}
            </div>
          )}
          <div className="igt-token-col">
            <div className="igt-token-form" title={word}>
              <span className="igt-vocab">
                {word}
                <Hint itemId={analysis?.word?.vocabItemId} itemFormById={itemFormById} />
              </span>
            </div>
            {wordFields.map((name) => (
              <div key={name} className="igt-cell">
                <Field value={analysis?.word?.fields?.[name]} label={`${name} for ${word}`} />
              </div>
            ))}
            {hasMorphemes && (
              <div className="igt-morphemes">
                {morphemes.map((m, i) => {
                  const joiner =
                    i > 0 ? morphemeJoiner(morphemes[i - 1]?.morphType, m.morphType) : null;
                  const stem = !!m.vocabItemId && isStemType(m.morphType);
                  return [
                    joiner ? (
                      <span key={`j${i}`} className="igt-morph-joiner" aria-hidden="true">
                        {joiner}
                      </span>
                    ) : null,
                    <div key={`m${i}`} className="igt-morph-col">
                      <div className={cn('igt-morph-form', stem && 'igt-morph-form--stem')}>
                        <span className="igt-vocab">
                          <Field
                            value={m.form}
                            className="igt-morph-field"
                            label={`Morpheme form ${m.form ?? ''}`}
                          />
                          <Hint itemId={m.vocabItemId} itemFormById={itemFormById} />
                        </span>
                      </div>
                      {morphFields.map((name) => (
                        <div key={name} className="igt-morph-cell">
                          <Field
                            value={m.fields?.[name]}
                            className="igt-morph-field"
                            label={`${name} for morpheme ${m.form ?? ''}`}
                          />
                        </div>
                      ))}
                    </div>,
                  ];
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
