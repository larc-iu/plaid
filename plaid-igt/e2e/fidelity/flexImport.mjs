// The FLEx .fwbackup import, driven the way the import screen drives it, for
// the runs that need a real FieldWorks project on a core.
//
// Two steps, kept apart because the accounting run (flexAccount.mjs) counts
// what comes out of each: `parseBackup` reads the file and plans the import,
// `importParsed` sets a project up from that plan and runs the engine.

import { readFileSync } from 'node:fs';
import { executeProjectSetup } from '../../src/components/projects/setup/executeSetup.js';
import { buildDocuments } from '../../src/import/flex/buildDocuments.js';
import { readFwbackup } from '../../src/import/flex/fwbackup.js';
import { parseFwdata } from '../../src/import/flex/fwdataParser.js';
import { deriveImportConfig, runImport } from '../../src/import/flex/importEngine.js';

/**
 * Read one .fwbackup and plan its import.
 *
 * `docCap` keeps only that many of the project's smallest texts, which is what
 * makes a sweep over real corpora quick enough to run often.
 */
export function parseBackup(path, { docCap = 0 } = {}) {
  const { name, xml } = readFwbackup(new Uint8Array(readFileSync(path)));
  const ir = parseFwdata(xml);
  const build = buildDocuments(ir);
  const stats = { ...build.stats };
  if (docCap > 0 && build.documents.length > docCap) {
    build.documents = [...build.documents]
      .sort((a, b) => a.words.length - b.words.length)
      .slice(0, docCap);
  }
  return { name, ir, build, stats, config: deriveImportConfig(ir, build, {}) };
}

/** Set a project up from the plan and run the engine, as the screen does. */
export async function importParsed(client, { ir, build, config }, name) {
  const setup = await executeProjectSetup({
    client,
    isNewProject: true,
    resumeProjectId: null,
    setupData: {
      basicInfo: { projectName: name },
      orthographies: {
        orthographies: [
          { name: 'Baseline', isBaseline: true },
          ...config.orthographies.map((o) => ({ name: o.name })),
        ],
      },
      fields: {
        fields: config.fields.map((f) => ({ name: f.name, scope: f.scope, isCustom: true })),
        ignoredTokens: {
          mode: 'unicode-punctuation',
          unicodePunctuationExceptions: [],
          explicitIgnoredTokens: [],
        },
      },
      vocabulary: {
        vocabularies: [{ id: 'new-flex', name: `${name} Lexicon`, enabled: true, isCustom: true }],
      },
      documentMetadata: {
        enabledFields: (config.documentMetadata || []).map((m) => ({
          name: m.name,
          enabled: true,
          isCustom: true,
        })),
      },
    },
  });
  if (setup.failures.length) throw new Error(`setup: ${setup.failures.join('; ')}`);
  const result = await runImport({
    client,
    projectId: setup.projectId,
    build,
    lexicon: ir.lexicon,
    config,
    vocabId: setup.resources.vocabularies[0].id,
  });
  return { projectId: setup.projectId, result };
}
