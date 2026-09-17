import { describe, it, expect, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { ElanFiles } from './ElanFiles.jsx';
import { ElanPreview } from './ElanPreview.jsx';

let view;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const wav = { name: 'story.wav', size: 1000, type: 'audio/wav' };
const stray = { name: 'other.wav', size: 2000, type: 'audio/wav' };
const FILES = [
  { fileName: 'story.eaf', tiers: [1, 2], media: [{ url: 'story.wav' }] },
  { fileName: 'song.eaf', tiers: [1, 2], media: [{ url: 'song.wav' }] },
];
const DOCS = [
  { id: 'story.eaf', name: 'Story', sentences: [{}, {}] },
  { id: 'song.eaf', name: 'Song', sentences: [{}] },
];
const base = {
  files: FILES,
  mediaFiles: [wav, stray],
  media: { byFile: new Map([['story.eaf', wav]]) },
  durations: new Map(),
  documents: DOCS,
};
const rowOf = (name) =>
  [...view.container.querySelectorAll('li')]
    .filter((li) => !li.querySelector('ul') && li.textContent.includes(name))
    .map((li) => li.textContent.replace(/\s+/g, ' ').trim())[0];

describe('ElanFiles', () => {
  it('says on each file what it becomes, and nests its recording under it', async () => {
    view = await renderComponent(
      <MemoryRouter>
        <ElanFiles {...base} />
      </MemoryRouter>,
    );
    expect(rowOf('story.eaf')).toBe('story.eaf→ Story · 2 sentences');
    expect(rowOf('song.eaf')).toBe('song.eaf→ Song · 1 sentencerecording not chosen');
    expect(rowOf('other.wav')).toContain('no .eaf names this file');
    // With no project to compare against, nothing claims to be new.
    expect(view.container.textContent).not.toContain('new');
    expect(view.container.querySelector('[role="radiogroup"]')).toBeNull();
  });

  it('marks what the project has, asks once, and says where a kept recording goes', async () => {
    const imported = new Map([['story.eaf', { id: 'd1', name: 'Story', mediaUrl: null }]]);
    const picked = [];
    view = await renderComponent(
      <MemoryRouter>
        <ElanFiles
          {...base}
          imported={imported}
          projectId="p1"
          priorMode="skip"
          onPriorMode={(m) => picked.push(m)}
        />
      </MemoryRouter>,
    );
    expect(rowOf('story.eaf')).toContain('in this project as Story');
    expect(view.container.querySelector('a[href="/projects/p1/documents/d1"]')).not.toBeNull();
    expect(rowOf('song.eaf')).toContain('new');
    expect(rowOf('story.wav')).toContain('added to the document');
    expect(view.container.textContent).toContain('1 of these files was imported before');
    await view.step(() => view.container.querySelector('input[value="copy"]').click());
    expect(picked).toEqual(['copy']);
  });
});

describe('ElanPreview', () => {
  const build = {
    documents: [
      {
        name: 'Story',
        body: 'again fesan\nyai',
        sentences: [
          { begin: 0, end: 12, fields: { Translation: 'he takes it' } },
          { begin: 12, end: 15, fields: {} },
        ],
        words: [
          {
            begin: 0,
            end: 5,
            sentenceIndex: 0,
            fields: {},
            morphemes: [
              { form: 'a', morphType: null, fields: { Gloss: '3' } },
              { form: 'gain', morphType: null, fields: { Gloss: 'take' } },
            ],
          },
          { begin: 6, end: 11, sentenceIndex: 0, fields: {}, morphemes: [] },
          { begin: 12, end: 15, sentenceIndex: 1, fields: {}, morphemes: [] },
        ],
      },
    ],
  };

  it('draws the sentence as lines and steps to the next', async () => {
    view = await renderComponent(<ElanPreview build={build} />);
    const text = () => view.container.textContent;
    expect(text()).toContain('Sentence 1 of 2');
    expect(text()).toContain('a-gain');
    expect(text()).toContain('3-take');
    expect(text()).toContain('he takes it');
    await view.step(() => view.container.querySelector('[aria-label="Next sentence"]').click());
    expect(text()).toContain('Sentence 2 of 2');
    expect(text()).toContain('yai');
    expect(text()).not.toContain('a-gain');
  });

  it('draws nothing until the mapping builds a document', async () => {
    view = await renderComponent(<ElanPreview build={null} />);
    expect(view.container.textContent).toBe('');
  });
});
