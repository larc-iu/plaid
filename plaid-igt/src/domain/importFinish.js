// The end of an import, however it ends: run to the end, resumed to the end,
// or ended by "Use the project as it is". Relative imports only: the
// fidelity drivers run this from plain node.
import { markImportFinished } from './igtConfig.js';
import { declareIgtRules } from './igtConstraints.js';
import {
  NOT_IN_FORCE_ACTION,
  notInForceLines,
} from '../components/projects/settings/refusedValues.js';

/**
 * Put IGT's rules in force on the project as it now stands, as setup does
 * (`declareIgtRules`), then drop the import record so the project opens. An
 * import stopped part way has written its tagsets and each field's reference
 * to one, so a closed list goes in force here even though the import never
 * reached its own last step. Returns `{cleared, warnings}`: whether the
 * record went, and a line for each list left out of force or a failure to
 * declare (the record is cleared all the same).
 */
export const finishImport = async (client, projectId) => {
  const warnings = [];
  try {
    const { notInForce } = await declareIgtRules(client, projectId);
    warnings.push(...notInForceLines(notInForce).map((line) => `${line} ${NOT_IN_FORCE_ACTION}`));
  } catch (err) {
    console.error('Could not put the annotation rules in force:', err);
    warnings.push('The annotation rules were not set.');
  }
  return { cleared: await markImportFinished(client, projectId), warnings };
};
