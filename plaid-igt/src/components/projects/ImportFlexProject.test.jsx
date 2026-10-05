import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// A resumed import locks its review to the first run's answers. Reading the
// file again ("Choose another file") must give the same answers again, not
// the defaults: locked, the defaults could not be unticked, and the resume
// would import every text the first run left out.

const auth = vi.hoisted(() => ({
  client: { server: { limits: async () => ({ mediaFileBytes: 1000 }) } },
  user: { id: 'u', isAdmin: true },
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));

const TEXT = (n) => `
  <interlinear-text guid="bbbbbbbb-0000-0000-0000-00000000000${n}">
    <item type="title" lang="xx">Text ${n}</item>
    <paragraphs><paragraph><phrases><phrase><words>
      <word><item type="txt" lang="xx">dogs</item><item type="gls" lang="en">dogs</item><item type="gls" lang="fr">chiens</item></word>
      <word><item type="txt" lang="xx">run</item><item type="gls" lang="en">run</item><item type="gls" lang="fr">courent</item></word>
    </words></phrase></phrases></paragraph></paragraphs>
    <languages><language lang="xx" vernacular="true"/><language lang="en"/><language lang="fr"/></languages>
  </interlinear-text>`;
const FLEXTEXT = `<?xml version="1.0" encoding="utf-8"?><document version="2">${TEXT(1)}${TEXT(2)}${TEXT(3)}</document>`;

const RECORD = {
  kind: 'FLEx .flextext',
  source: 'three.flextext',
  vocabId: null,
  choices: {
    texts: ['bbbbbbbb-0000-0000-0000-000000000002'],
    analysisWss: ['en'],
    posWs: null,
    lexiconFields: [],
    orthoNames: {},
    importVariants: false,
  },
};
vi.mock('@/hooks/useResumeImport', () => ({
  useResumeImport: () => ({
    resumeId: 'p1',
    resumeName: 'Three',
    resumeProject: { id: 'p1', name: 'Three', vocabs: [], config: { igt: { import: RECORD } } },
    finishAsIs: () => {},
  }),
}));

const { ImportFlexProject, RecordingsSummary } = await import('./ImportFlexProject.jsx');
const { matchRecordings } = await import('../../import/flex/recordings.js');

const pick = async (view) => {
  const input = view.container.querySelector('input[type="file"]');
  const file = new File([FLEXTEXT], 'three.flextext', { type: 'text/xml' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await view.step(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // The reader yields 50ms before parsing, so the spinner can paint.
    await new Promise((r) => setTimeout(r, 120));
  });
};

const ticked = (view) => {
  const boxes = [...view.container.querySelectorAll('label')]
    .filter((l) => l.querySelector('input[type="checkbox"]'))
    .map((l) => ({ text: l.textContent, on: l.querySelector('input').checked }));
  return boxes.filter((b) => b.on).map((b) => b.text.replace(/\s+/g, ' ').trim());
};

describe('ImportFlexProject on a resume', () => {
  it('gives every read of the file the first run’s answers', async () => {
    const view = await renderComponent(
      <MemoryRouter>
        <ImportFlexProject format="flextext" />
      </MemoryRouter>,
    );
    await pick(view);
    const first = ticked(view);
    expect(first.some((t) => t.startsWith('Text 2'))).toBe(true);
    expect(first.some((t) => t.startsWith('Text 1') || t.startsWith('Text 3'))).toBe(false);
    expect(first).toContain('en');
    expect(first).not.toContain('fr');

    const again = [...view.container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Choose another file',
    );
    await view.step(async () => again.click());
    await pick(view);
    expect(ticked(view)).toEqual(first);
    expect(view.container.textContent).toContain('1 of 3 selected');
    await view.unmount();
  });
});

// FLEx names the recording each text's sentences were timed against.
describe('matchRecordings and RecordingsSummary', () => {
  const text = (guid, mediaName, extra = {}) => ({ guid, mediaName, ...extra });
  const media = (name, size = 10) => ({ name, size });
  const all = (docs) => new Set(docs.map((d) => d.guid));
  const show = async (recordings) =>
    (await renderComponent(<RecordingsSummary recordings={recordings} locked={false} />)).container
      .textContent;

  it('gives a recording two texts were timed against to both', async () => {
    const docs = [text('a', 'session.wav'), text('b', 'session.wav')];
    const wav = media('session.wav');
    const r = matchRecordings({ documents: docs, selected: all(docs), mediaFiles: [wav] });
    expect(r.byFile.get('a')).toBe(wav);
    expect(r.byFile.get('b')).toBe(wav);
    const shown = await show(r);
    expect(shown).toContain('Recordings: 2 of 2 texts with sentence times');
    expect(shown).not.toContain('Not chosen');
  });

  it('matches a name macOS wrote in another Unicode normalization', () => {
    const docs = [text('a', 'Narración_ñandú.wav'.normalize('NFC'))];
    const nfd = media('Narración_ñandú.wav'.normalize('NFD'));
    const r = matchRecordings({ documents: docs, selected: all(docs), mediaFiles: [nfd] });
    expect(r.byFile.get('a')).toBe(nfd);
    expect(r.missing).toEqual([]);
    expect(r.unmatched).toEqual([]);
  });

  it('counts only the texts chosen for import', async () => {
    const docs = [text('a', 'a.wav'), text('b', 'b.wav'), text('c', 'c.wav')];
    const r = matchRecordings({
      documents: docs,
      selected: new Set(['a']),
      mediaFiles: [media('a.wav')],
    });
    expect(await show(r)).toContain('Recordings: 1 of 1 text with sentence times');
  });

  it('refuses a recording over the server limit when it is chosen, and takes a smaller copy', async () => {
    const docs = [text('a', 'big.mov')];
    const big = media('big.mov', 2000);
    let r = matchRecordings({
      documents: docs,
      selected: all(docs),
      mediaFiles: [big],
      maxBytes: 1000,
    });
    expect(r.byFile.size).toBe(0);
    expect(r.tooLarge).toEqual([big]);
    expect(r.missing).toEqual([]);
    const shown = await show(r);
    expect(shown).toContain('Over the 1.0 KB limit: big.mov.');
    expect(shown).not.toContain('Not chosen');
    expect(shown).toContain('Add recordings');
    const mp3 = media('big.mp3', 500);
    r = matchRecordings({
      documents: docs,
      selected: all(docs),
      mediaFiles: [big, mp3],
      maxBytes: 1000,
    });
    expect(r.byFile.get('a')).toBe(mp3);
    expect(r.tooLarge).toEqual([]);
  });

  it('counts sentences timed against a second recording', async () => {
    const docs = [
      text('a', 'story.wav', {
        otherRecording: [
          { n: 2, mediaName: 'story.MOV' },
          { n: 5, mediaName: 'story.MOV' },
        ],
      }),
    ];
    const r = matchRecordings({ documents: docs, selected: all(docs), mediaFiles: [] });
    expect(await show(r)).toContain(
      '2 sentences timed against a second recording (story.MOV) are left untimed.',
    );
  });

  it('agrees with one sentence timed elsewhere or overlapping', async () => {
    const docs = [
      text('a', 'story.wav', {
        otherRecording: [{ n: 2, mediaName: 'story.MOV' }],
        timeWarnings: ['Utterance 3 overlaps'],
      }),
    ];
    const r = matchRecordings({ documents: docs, selected: all(docs), mediaFiles: [] });
    const shown = await show(r);
    expect(shown).toContain(
      '1 sentence timed against a second recording (story.MOV) is left untimed.',
    );
    expect(shown).toContain('1 sentence overlaps an earlier one in time and is left untimed.');
  });

  it('names recordings chosen with a backup whose texts have no times', async () => {
    const r = matchRecordings({
      documents: [text('a', null)],
      selected: new Set(['a']),
      mediaFiles: [media('x.wav')],
    });
    const shown = await show(r);
    expect(shown).toContain('No text uses: x.wav.');
    expect(shown).not.toContain('0 of');
  });
});
