import { describe, it, expect, vi } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';

const auth = vi.hoisted(() => ({
  client: { server: { limits: async () => ({ mediaFileBytes: 1000 }) } },
  user: { id: 'u', isAdmin: true },
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));

const { RecordingsSummary } = await import('./ImportFlexProject.jsx');
const { matchRecordings } = await import('../../import/flex/recordings.js');

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

  it('removes a recording no text uses', async () => {
    const x = media('x.wav');
    const r = matchRecordings({
      documents: [text('a', 'a.wav')],
      selected: new Set(['a']),
      mediaFiles: [x],
    });
    const onRemove = vi.fn();
    const view = await renderComponent(
      <RecordingsSummary recordings={r} locked={false} onRemove={onRemove} />,
    );
    const remove = view.container.querySelector('button[aria-label="Remove x.wav"]');
    await view.step(() => remove.click());
    expect(onRemove).toHaveBeenCalledWith(x);
    await view.unmount();
    const locked = await renderComponent(
      <RecordingsSummary recordings={r} locked onRemove={onRemove} />,
    );
    expect(locked.container.querySelector('button[aria-label="Remove x.wav"]')).toBeNull();
    await locked.unmount();
  });

  it('says which recording it is converting', async () => {
    const r = matchRecordings({ documents: [], selected: new Set(), mediaFiles: [] });
    const view = await renderComponent(
      <RecordingsSummary recordings={r} locked={false} decoding="story.wav" />,
    );
    expect(view.container.textContent).toContain('Converting story.wav to PCM WAV.');
    await view.unmount();
  });
});
