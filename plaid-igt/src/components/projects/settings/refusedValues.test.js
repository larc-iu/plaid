import { describe, it, expect } from 'vitest';
import { notInForceText } from './refusedValues.js';

// REV4-WIRE-2 and -3: what a field left out of force is named for, and the
// one step to take, said without "under Validation" on Validation itself.
describe('the notice for fields left out of force', () => {
  const listed = {
    field: 'Morph Gloss',
    tagset: 'Leipzig',
    count: 2,
    valueCount: 2,
    values: [
      { value: 'QQ', parts: ['QQ'], count: 1 },
      { value: 'ZZ', parts: ['ZZ'], count: 1 },
    ],
  };
  const doubled = {
    field: 'Raw note',
    count: 1,
    valueCount: 0,
    values: [],
    repair: ['single-span'],
    repairCount: 2,
    scope: 'Word',
  };

  it('names values off the list', () => {
    expect(notInForceText([listed])).toBe(
      '“Leipzig” is not in force on Morph Gloss: 2 annotations not in the list, QQ (1), ZZ (1). Change these values, then choose Put in force under Validation.',
    );
    expect(notInForceText([listed], { here: true })).toMatch(/then choose Put in force\.$/);
  });

  it('names units holding more than one annotation, by the field scope', () => {
    expect(notInForceText([doubled], { here: true })).toBe(
      'Raw note: 2 words with more than one annotation. Leave one annotation on each, then choose Put in force.',
    );
    expect(notInForceText([{ ...doubled, scope: 'Morpheme', repairCount: 1 }])).toBe(
      'Raw note: 1 morpheme with more than one annotation. Leave one annotation on each, then choose Put in force under Validation.',
    );
  });

  it('says both steps in one sentence', () => {
    expect(notInForceText([listed, doubled])).toMatch(
      / Change these values and leave one annotation on each, then choose Put in force under Validation\.$/,
    );
  });

  // REV5-WIRE-4: a rule refused for no value and no join, in words that agree.
  it('says a rule broken another way in a sentence that agrees with its count', () => {
    const other = { field: 'Raw note', count: 1, valueCount: 0, values: [] };
    expect(notInForceText([other])).toBe(
      'The rules of Raw note are not in force: 1 annotation breaks them. Change the annotations that break them, then choose Put in force under Validation.',
    );
    expect(notInForceText([{ ...other, count: 3 }])).toMatch(/: 3 annotations break them\. /);
  });

  // REV7-WIRE-3: doubles only on ignored words are not counted, and no step
  // is named that Analyze cannot take.
  it('says doubles only on ignored words with no step to take', () => {
    expect(notInForceText([{ ...doubled, repairCount: 0 }])).toBe(
      'Raw note: ignored words hold more than one annotation.',
    );
    expect(notInForceText([{ ...doubled, repairCount: 0, scope: 'Morpheme' }])).toBe(
      'Raw note: morphemes of ignored words hold more than one annotation.',
    );
    expect(notInForceText([listed, { ...doubled, repairCount: 0 }])).toMatch(
      / Change these values, then choose Put in force under Validation\.$/,
    );
  });
});
