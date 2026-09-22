import { describe, it, expect } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { useElanBatch } from './useElanBatch';
import { ROLES } from '@/import/elan/schema';

// A resumed ELAN import runs against the tier mapping the first run was given.
// Only one utterance root is ever suggested, so a corpus whose second speaker
// has a tier tree of their own is mapped by hand: re-suggesting the mapping on
// a resume drops that tree without a word, and the documents the resume redoes
// come back missing a voice.

const eaf = (tiers) => {
  const slots = [];
  const body = tiers
    .map((t) => {
      const anns = t.anns
        .map(([id, value, begin, end]) => {
          slots.push([`ts${slots.length + 1}`, begin], [`ts${slots.length + 2}`, end]);
          const [s1, s2] = [slots[slots.length - 2][0], slots[slots.length - 1][0]];
          return `<ANNOTATION><ALIGNABLE_ANNOTATION ANNOTATION_ID="${id}" TIME_SLOT_REF1="${s1}" TIME_SLOT_REF2="${s2}"><ANNOTATION_VALUE>${value}</ANNOTATION_VALUE></ALIGNABLE_ANNOTATION></ANNOTATION>`;
        })
        .join('');
      return `<TIER TIER_ID="${t.id}" LINGUISTIC_TYPE_REF="u">${anns}</TIER>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<ANNOTATION_DOCUMENT AUTHOR="t" DATE="2026-01-01T00:00:00Z" VERSION="2.8" FORMAT="2.8">
<HEADER TIME_UNITS="milliseconds"/>
<TIME_ORDER>${slots.map(([id, v]) => `<TIME_SLOT TIME_SLOT_ID="${id}" TIME_VALUE="${v}"/>`).join('')}</TIME_ORDER>
${body}<LINGUISTIC_TYPE LINGUISTIC_TYPE_ID="u" TIME_ALIGNABLE="true"/>
</ANNOTATION_DOCUMENT>`;
};

// One speaker's tier, plus a second speaker's, which nothing suggests a role for.
const TWO_SPEAKERS = [
  { id: 'Ana', anns: [['a1', 'los perros', 0, 1000]] },
  { id: 'Bo', anns: [['b1', 'los gatos', 1000, 2000]] },
];
// Two tiers whose names differ only in case: a near miss the user decides.
const NEAR_MISS = [
  { id: 'Phrase', anns: [['a1', 'hola', 0, 100]] },
  { id: 'phrase', anns: [['a2', 'adios', 200, 300]] },
];

const picked = (tiers) => [{ name: 'corpus.eaf', text: async () => eaf(tiers) }];

const Probe = ({ onReady }) => {
  const batch = useElanBatch();
  onReady(batch);
  return null;
};

const mount = async () => {
  let last = null;
  const view = await renderComponent(<Probe onReady={(b) => (last = b)} />);
  return { ...view, read: () => last };
};

const keyOf = (batch, baseName) => batch.nodes.find((n) => n.baseName === baseName)?.key;

describe('useElanBatch on a resume', () => {
  it('suggests a role for one speaker only, which is what a resume would lose', async () => {
    const v = await mount();
    await v.step(() => v.read().readFiles(picked(TWO_SPEAKERS)));
    const batch = v.read();
    expect(batch.roles[keyOf(batch, 'Ana')]).toBe(ROLES.UTTERANCE);
    expect(batch.roles[keyOf(batch, 'Bo')]).toBe(ROLES.OFF);
    await v.unmount();
  });

  it('takes the roles, names and media choice the first run was answered with', async () => {
    const first = await mount();
    await first.step(() => first.read().readFiles(picked(TWO_SPEAKERS)));
    const ana = keyOf(first.read(), 'Ana');
    const bo = keyOf(first.read(), 'Bo');
    // The second speaker's tree, mapped by hand, and a field renamed.
    await first.step(() => first.read().setRole(bo, ROLES.UTTERANCE));
    await first.step(() => first.read().setName(bo, 'Second voice'));
    await first.step(() => first.read().setRecordMediaName(false));
    const recorded = first.read().choices;
    expect(recorded.roles[bo]).toBe(ROLES.UTTERANCE);
    await first.unmount();

    const again = await mount();
    await again.step(() => again.read().readFiles(picked(TWO_SPEAKERS), recorded));
    const batch = again.read();
    expect(batch.roles[bo]).toBe(ROLES.UTTERANCE);
    expect(batch.roles[ana]).toBe(ROLES.UTTERANCE);
    expect(batch.fieldNames[bo]).toBe('Second voice');
    expect(batch.recordMediaName).toBe(false);
    await again.unmount();
  });

  it('takes the merge decisions too, so the batch reads as it did', async () => {
    const v = await mount();
    await v.step(() => v.read().readFiles(picked(NEAR_MISS)));
    expect(v.read().nodes).toHaveLength(2);
    expect(v.read().undecidedNearMisses).toHaveLength(1);
    await v.step(() => v.read().chooseNearMiss('phrase', 'Phrase'));
    expect(v.read().nodes).toHaveLength(1);
    const recorded = v.read().choices;
    await v.unmount();

    const again = await mount();
    await again.step(() => again.read().readFiles(picked(NEAR_MISS), recorded));
    expect(again.read().nodes).toHaveLength(1);
    expect(again.read().nodes[0].baseName).toBe('Phrase');
    // The pair is still reported, and still answered.
    expect(again.read().nearMissGroups).toHaveLength(1);
    expect(again.read().undecidedNearMisses).toEqual([]);
    await again.unmount();
  });

  it('drops a recorded answer for a tier the batch no longer has', async () => {
    const v = await mount();
    await v.step(() =>
      v.read().readFiles(picked(TWO_SPEAKERS), {
        roles: { 'gone:u': ROLES.MORPHEME },
        fieldNames: { 'gone:u': 'Nowhere' },
      }),
    );
    const batch = v.read();
    expect(batch.roles['gone:u']).toBeUndefined();
    expect(batch.fieldNames['gone:u']).toBeUndefined();
    expect(batch.roles[keyOf(batch, 'Ana')]).toBe(ROLES.UTTERANCE);
    await v.unmount();
  });
});
