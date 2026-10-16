// The end of an import, however it ends: run to the end, resumed to the end,
// or ended by "Use the project as it is". Relative imports only: the
// fidelity drivers run this from plain node.
import { markImportFinished, readImportState } from './igtConfig.js';
import { declareIgtRules } from './igtConstraints.js';
import { notInForceText } from '../components/projects/settings/refusedValues.js';

/** The import record's kind for a Plaid IGT archive (ImportNativeProject.jsx). */
export const NATIVE_IMPORT_KIND = 'Plaid IGT archive';

/**
 * Whether putting the rules in force at the end of the import recorded in
 * `config` may repair the data it brought in. A native archive is the
 * project as it was, so two annotations it holds on a unit stay, and the
 * field is named instead.
 */
export const importRepairs = (config) => readImportState(config)?.kind !== NATIVE_IMPORT_KIND;

/**
 * Put IGT's rules in force on the project as it now stands, as setup does
 * (`declareIgtRules`, with no repair after a native archive), then drop the
 * import record so the project opens. An
 * import stopped part way has written its tagsets and each field's reference
 * to one, so a closed list goes in force here even though the import never
 * reached its own last step. Returns `{cleared, warnings}`: whether the
 * record went, and a line for each list left out of force or a failure to
 * declare (the record is cleared all the same).
 */
export const finishImport = async (client, projectId) => {
  const warnings = [];
  try {
    const repair = importRepairs((await client.projects.get(projectId))?.config);
    const { notInForce } = await declareIgtRules(client, projectId, { repair });
    warnings.push(...notInForce.map((f) => notInForceText([f])));
  } catch (err) {
    console.error('Could not put the annotation rules in force:', err);
    warnings.push('The annotation rules were not set.');
  }
  return { cleared: await markImportFinished(client, projectId), warnings };
};
