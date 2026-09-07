// Which sentence layers a dictionary can show under an example.
//
// An example points into a document, and the document's project decides what a
// sentence can carry: a translation, a second translation in another writing
// system, notes of several kinds. Which of those belong in the dictionary is
// the compiler's choice, so setup asks.
//
// The candidates are discovered without reading a single document body. A
// document fetched without its body is under a kilobyte and names its project;
// the project carries the whole layer tree. Reading the documents themselves
// would be megabytes each for the same six names.

import { getIgtLayerInfo } from '@igt/domain/layerInfo.js';
import { allExamples } from '@igt/domain/vocabDictionary.js';

/** The documents a vocabulary's examples point into. */
export const exampleDocumentIds = (items) => {
  const ids = new Set();
  for (const item of items || []) {
    for (const example of allExamples(item)) {
      if (example.document) ids.add(example.document);
    }
  }
  return [...ids];
};

/** A project's sentence-scope span layers, by name, in the project's order. */
export const sentenceLayerNames = (project) =>
  (getIgtLayerInfo(project)?.spanLayers?.sentence || []).map((layer) => layer.name);

/**
 * Every sentence layer this vocabulary's examples could show, in the order
 * their projects list them. A document or project that cannot be read
 * contributes nothing rather than failing the lot: a dictionary may draw
 * examples from a project a reader has since lost access to.
 */
export const discoverExampleLayers = async (client, items) => {
  const documentIds = exampleDocumentIds(items);
  if (!documentIds.length) return [];

  const projectIds = [];
  const seenProject = new Set();
  const documents = await Promise.all(
    documentIds.map(async (id) => {
      try {
        return await client.documents.get(id, false);
      } catch {
        return null;
      }
    }),
  );
  for (const doc of documents) {
    if (doc?.project && !seenProject.has(doc.project)) {
      seenProject.add(doc.project);
      projectIds.push(doc.project);
    }
  }

  const perProject = await Promise.all(
    projectIds.map(async (id) => {
      try {
        return sentenceLayerNames(await client.projects.get(id));
      } catch {
        return [];
      }
    }),
  );

  const names = [];
  for (const list of perProject) {
    for (const name of list) if (!names.includes(name)) names.push(name);
  }
  return names;
};
