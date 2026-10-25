import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { parseUmrFile } from '../../../domain/format/umrFile.js';
import { planImport } from '../../../domain/umrImport.js';
import { UmrDocument } from '../../../domain/UmrDocument.js';
import { rawFromPlan } from '../../../../test/rawFromPlan.js';
import { recordingClient } from '../../../../test/recordingClient.js';
import { UmrCanvas } from './UmrCanvas.jsx';

// The lexicon each sentence block was handed, last render first.
const handed = vi.hoisted(() => []);
vi.mock('./SentenceBlock.jsx', () => ({
  SentenceBlock: ({ lexicon }) => {
    handed.unshift(lexicon);
    return <div className="umr-block" />;
  },
}));

const FILE = `${'#'.repeat(80)}
# :: snt1\tkitap verdi
Index: 1 2
Words: kitap verdi

# sentence level graph:
(s1v / ver-01 :ARG1 (s1k / kitap))

# alignment:
s1v: 2-2
s1k: 1-1

# document level annotation:
(s1s0 / sentence)
`;

const VOCAB = { id: 'v1', name: 'Turkish', items: [{ id: 'kitap', form: 'kitap', metadata: {} }] };

// B5-8: the canvas read the vocabularies again beside the document's own read,
// and its pickers and the entry check each held a lexicon of their own.
describe('UmrCanvas and the vocabularies', () => {
  it("reads them once, through the document, and hands the blocks the document's lexicon", async () => {
    const raw = rawFromPlan(planImport(parseUmrFile(FILE).sentences, []));
    const { client } = recordingClient();
    client.vocabLayers = { get: vi.fn(async () => VOCAB) };
    const doc = new UmrDocument({ raw, client, project: { id: 'p', vocabs: [{ id: 'v1' }] } });
    doc._reload = async () => {};
    const view = () => (
      <MemoryRouter>
        <UmrCanvas doc={doc} readOnly={false} />
      </MemoryRouter>
    );
    const r = await renderComponent(view());
    // The editor's read (AnnotationEditor's loadLexicon).
    await r.step(() => doc.loadLexicon());
    await r.rerender(view());
    expect(client.vocabLayers.get).toHaveBeenCalledTimes(1);
    expect(doc.lexicon.entries.length).toBeGreaterThan(0);
    expect(handed[0]).toBe(doc.lexicon);
    await r.unmount();
  });
});
