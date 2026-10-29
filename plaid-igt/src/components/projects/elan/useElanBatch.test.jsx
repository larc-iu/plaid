import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { notifyError, notifyInfo } from '@/utils/feedback';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { useElanBatch } from './useElanBatch';
import { ROLES } from '@/import/elan/schema';

vi.mock('@/utils/feedback', () => ({ notifyError: vi.fn(), notifyInfo: vi.fn() }));

// Only one utterance root is ever suggested, so a corpus whose second speaker
// has a tier tree of their own is mapped by hand.

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

const picked = (tiers) => [new File([eaf(tiers)], 'corpus.eaf')];
const pickedAs = (names, tiers) => names.map((name) => new File([eaf(tiers)], name));

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

describe('useElanBatch mapping', () => {
  it('suggests a role for one speaker only', async () => {
    const v = await mount();
    await v.step(() => v.read().readFiles(picked(TWO_SPEAKERS)));
    const batch = v.read();
    expect(batch.roles[keyOf(batch, 'Ana')]).toBe(ROLES.UTTERANCE);
    expect(batch.roles[keyOf(batch, 'Bo')]).toBe(ROLES.OFF);
    await v.unmount();
  });

  it('keeps the merge decisions and the mapping when an .eaf is taken out', async () => {
    // Removing a file re-derives the schema from what is left. Dropping the
    // merge decisions there un-folds the tiers the mapping is filed under.
    const FILES = ['one.eaf', 'two.eaf'];
    const TIERS = [...NEAR_MISS, { id: 'Bo', anns: [['b1', 'los gatos', 400, 500]] }];

    const again = await mount();
    await again.step(() => again.read().readFiles(pickedAs(FILES, TIERS)));
    await again.step(() => again.read().chooseNearMiss('phrase', 'Phrase'));
    const bo = keyOf(again.read(), 'Bo');
    const folded = keyOf(again.read(), 'Phrase');
    await again.step(() => again.read().setRole(bo, ROLES.UTTERANCE));
    await again.step(() => again.read().setName(folded, 'Transcription'));
    expect(again.read().undecidedNearMisses).toEqual([]);
    await again.step(() => again.read().removeEaf('two.eaf'));
    expect(again.read().files.map((f) => f.fileName)).toEqual(['one.eaf']);
    expect(again.read().nearMissChoices).toEqual({ phrase: 'Phrase' });
    expect(again.read().undecidedNearMisses).toEqual([]);
    expect(again.read().roles[bo]).toBe(ROLES.UTTERANCE);
    expect(again.read().fieldNames[folded]).toBe('Transcription');
    await again.unmount();
  });
});

// ELAN saves UTF-8, but an .eaf passed through a Windows editor can come back
// UTF-16. With its byte order mark it reads as what it is, and without one
// it is refused by name before anything is written.
describe('useElanBatch reading the files', () => {
  const utf16le = (s, bom) => {
    const out = bom ? [0xff, 0xfe] : [];
    for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff, s.charCodeAt(i) >> 8);
    return new Uint8Array(out);
  };

  it('reads an .eaf saved as UTF-16 with a byte order mark', async () => {
    const v = await mount();
    const file = new File([utf16le(eaf(TWO_SPEAKERS), true)], 'corpus.eaf');
    await v.step(() => v.read().readFiles([file]));
    expect(keyOf(v.read(), 'Ana')).toBeTruthy();
    await v.unmount();
  });

  it('refuses an .eaf with a NUL in it, by name', async () => {
    const v = await mount();
    const file = new File([utf16le(eaf(TWO_SPEAKERS), false)], 'corpus.eaf');
    await expect(v.read().readFiles([file])).rejects.toThrow(
      'corpus.eaf is not UTF-8. Save it as UTF-8 and import it again.',
    );
    await v.unmount();
  });
});

// The recordings chosen with a batch are readied as they are chosen: an ADPCM
// WAV, which no browser plays, is staged as its PCM decoding under the same
// name, so it still pairs with the .eaf that names it, and a WAV coding that
// cannot be converted is refused by name and never staged.
describe('useElanBatch recordings', () => {
  const fixture = (name, as) =>
    new File(
      [
        readFileSync(
          path.join(
            path.dirname(fileURLToPath(import.meta.url)),
            '../../../domain/media/adpcm-fixtures',
            name,
          ),
        ),
      ],
      as,
      { type: 'audio/wav' },
    );
  const named = (recording) =>
    eaf(TWO_SPEAKERS).replace(
      '<HEADER TIME_UNITS="milliseconds"/>',
      `<HEADER TIME_UNITS="milliseconds"><MEDIA_DESCRIPTOR MEDIA_URL="file:///${recording}" MIME_TYPE="audio/x-wav" RELATIVE_MEDIA_URL="./${recording}"/></HEADER>`,
    );

  it('stages an ADPCM WAV as PCM, paired with its .eaf, and says so', async () => {
    notifyInfo.mockClear();
    const v = await mount();
    const adpcm = fixture('ima-stereo.wav', 'story.wav');
    await v.step(() => v.read().readFiles([new File([named('story.wav')], 'story.eaf'), adpcm]));
    const [staged] = v.read().mediaFiles;
    expect(staged.name).toBe('story.wav');
    expect(staged).not.toBe(adpcm);
    expect(staged.size).toBe(fixture('ima-stereo.ref.wav', 'x').size);
    expect(v.read().media.byFile.get('story.eaf')).toBe(staged);
    expect(notifyInfo).toHaveBeenCalledWith('Converted story.wav from IMA ADPCM to PCM WAV.');
    await v.unmount();
  });

  it('refuses a WAV it cannot convert, by name, and stages the rest', async () => {
    notifyError.mockClear();
    const v = await mount();
    await v.step(() =>
      v
        .read()
        .readFiles([
          new File([named('a.wav')], 'a.eaf'),
          fixture('g721.wav', 'a.wav'),
          fixture('pcm.wav', 'b.wav'),
        ]),
    );
    expect(v.read().mediaFiles.map((f) => f.name)).toEqual(['b.wav']);
    expect(notifyError).toHaveBeenCalledWith(
      'a.wav cannot be played in a browser (G.721 ADPCM WAV).',
    );
    await v.unmount();
  });

  it('adds nothing and throws nothing when every recording added later is refused', async () => {
    const v = await mount();
    await v.step(() => v.read().readFiles(picked(TWO_SPEAKERS)));
    let answer;
    await v.step(async () => {
      answer = await v.read().readFiles([fixture('gsm.wav', 'late.wav')]);
    });
    expect(answer).toBe(false);
    expect(v.read().mediaFiles).toEqual([]);
    await v.unmount();
  });
});
