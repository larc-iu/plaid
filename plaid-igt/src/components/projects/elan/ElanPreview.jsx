// Step 3 of the review: a sentence of the first document as the interlinear
// lines the import would write, redrawn as the tier mapping changes.
//
// A .eaf holds no running text: the document's text is SYNTHESIZED from the
// tier mapped to Sentences, and everything under it lands where the mapping
// says. Counts cannot show a gloss tier mapped onto words, or a morph tier
// that is there and empty, and the lines show both at a glance. A corpus that
// is segmented but not yet transcribed shows its placeholder here, which is
// the thing its owner most needs to see before importing 665 of them.

import { Fragment, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { previewSentence } from '@/import/elan/preview.js';
import { ElanSection } from './ElanSection.jsx';

// The Analyze grid's own stripes: what a row is a row OF.
const STRIPES = {
  words: 'border-transparent',
  orthography: 'border-slate-400',
  word: 'border-blue-600',
  morphemes: 'border-teal-700',
  morpheme: 'border-teal-700',
  sentence: 'border-green-700',
};

const Label = ({ kind, children }) => (
  <div
    className={`whitespace-nowrap border-s-2 ps-2 text-xs text-muted-foreground ${STRIPES[kind]}`}
  >
    {children}
  </div>
);

export const ElanPreview = ({ step = 3, build }) => {
  const [at, setAt] = useState(0);
  const doc = build?.documents?.[0];
  if (!doc?.sentences?.length) return null;
  const count = doc.sentences.length;
  // A mapping change can shorten the document under the counter.
  const index = Math.min(at, count - 1);
  const shown = previewSentence(doc, index);
  if (!shown) return null;

  return (
    <ElanSection
      step={step}
      title="Preview"
      note={build.documents.length > 1 ? `“${doc.name}”, as it will be imported.` : null}
      aside={
        count > 1 && (
          <>
            <span className="text-xs tabular-nums text-muted-foreground">
              Sentence {index + 1} of {count}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              aria-label="Previous sentence"
              disabled={index === 0}
              onClick={() => setAt(index - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              aria-label="Next sentence"
              disabled={index === count - 1}
              onClick={() => setAt(index + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-2 rounded-md border bg-muted/20 p-3">
        {shown.words.length > 0 ? (
          <div className="overflow-x-auto">
            <div
              className="grid w-max items-baseline gap-x-4 gap-y-1 text-sm"
              style={{
                gridTemplateColumns: `max-content repeat(${shown.words.length}, max-content)`,
              }}
              dir="auto"
            >
              <Label kind="words">Words</Label>
              {shown.words.map((w, i) => (
                <div key={i} className="font-semibold" dir="auto">
                  {w}
                </div>
              ))}
              {shown.rows.map((row) => (
                <Fragment key={`${row.kind}:${row.label}`}>
                  <Label kind={row.kind}>{row.label}</Label>
                  {row.cells.map((cell, i) => (
                    <div
                      key={i}
                      dir="auto"
                      className={
                        row.kind === 'morphemes' && shown.unanalyzed[i]
                          ? 'text-muted-foreground'
                          : undefined
                      }
                    >
                      {cell || <span className="text-muted-foreground/50">·</span>}
                    </div>
                  ))}
                </Fragment>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">This sentence has no words.</p>
        )}
        {shown.fields.length > 0 && (
          <div className="grid grid-cols-[max-content_1fr] items-baseline gap-x-4 gap-y-1 border-t pt-2 text-sm">
            {shown.fields.map(([name, value]) => (
              <Fragment key={name}>
                <Label kind="sentence">{name}</Label>
                <div dir="auto">{value}</div>
              </Fragment>
            ))}
          </div>
        )}
      </div>
    </ElanSection>
  );
};
