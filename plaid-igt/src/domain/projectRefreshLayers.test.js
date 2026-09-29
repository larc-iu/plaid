// A layer's config comes with the document, and a maintainer can change it
// while the document is open: which tagset a field checks against, above all.
// The project read that follows a refetch or a return to the tab carries every
// layer with its config, but the grid read the layer from the document, so a
// field assigned a closed tagset since the page loaded still let any value
// through (REV-W-SETTINGS2 O1). The document's layers now take the config the
// project read gives them.
import { describe, it, expect } from 'vitest';
import { IgtDocument } from './IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from './test-helpers.js';

const setup = () => {
  resetIds();
  const raw = buildRawDoc();
  const server = {
    project: {
      id: 'proj-1',
      vocabs: [],
      config: { igt: { tagsets: { Cats: { delimiters: '.', mode: 'closed', values: [] } } } },
      textLayers: structuredClone(raw.textLayers),
    },
  };
  const client = makeFakeClient();
  client.projects.get = async () => structuredClone(server.project);
  const doc = new IgtDocument({
    raw,
    project: structuredClone(server.project),
    client,
    projectId: 'proj-1',
  });
  return { doc, server };
};

const layersOf = (textLayers) =>
  textLayers.flatMap((tl) => (tl.tokenLayers || []).flatMap((t) => t.spanLayers || []));
const gloss = (doc) => doc.layerInfo.spanLayers.morpheme.find((sl) => sl.id === 'msl-0');

describe("a field's layer config changed while the document is open", () => {
  it('reaches the document when the project is read again', async () => {
    const { doc, server } = setup();
    expect(gloss(doc).config.igt.tagset).toBeUndefined();
    layersOf(server.project.textLayers).find((sl) => sl.id === 'msl-0').config.igt.tagset = 'Cats';
    expect(await doc.refreshProject()).toBe(true);
    expect(gloss(doc).config.igt.tagset).toBe('Cats');

    // And back.
    delete layersOf(server.project.textLayers).find((sl) => sl.id === 'msl-0').config.igt.tagset;
    expect(await doc.refreshProject()).toBe(true);
    expect(gloss(doc).config.igt.tagset).toBeUndefined();
  });

  it('leaves the other layers as they are', async () => {
    const { doc, server } = setup();
    const before = doc.layerInfo.spanLayers.word.map((sl) => sl.config);
    layersOf(server.project.textLayers).find((sl) => sl.id === 'msl-0').config.igt.tagset = 'Cats';
    await doc.refreshProject();
    expect(doc.layerInfo.spanLayers.word.map((sl) => sl.config)).toEqual(before);
  });
});
