// The end of an import, however it ends: run to the end, resumed to the end,
// or ended by "Use the project as it is". Relative imports only: the
// fidelity drivers run this from plain node.
import {
  markImportEnding,
  markImportFinished,
  readImportState,
  readInitialized,
} from './igtConfig.js';
import { declareIgtRules } from './igtConstraints.js';
import { notInForceText } from '../components/projects/settings/refusedValues.js';
import { finishArchiveImport } from '../import/native/importEngine.js';

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
 * reached its own last step. A native archive's import that stopped runs its
 * own last step instead (`finishArchiveImport`, from the plan it keeps on the
 * record): every reference it rewrites, other apps' layer rules and IGT's.
 * Returns `{cleared, warnings}`: whether the record went, and a line for
 * each list left out of force, each reference dropped or a failure to
 * declare. The record is cleared all the same, but for an archive's last
 * step that fails or fails to declare a rule, which stays on the record to
 * be run again.
 */
export const finishImport = async (client, projectId) => {
  const warnings = [];
  try {
    const config = (await client.projects.get(projectId))?.config;
    const record = readImportState(config);
    if (record?.kind === NATIVE_IMPORT_KIND && record.finish) {
      // Left on the record when it fails, so ending the import again redoes
      // it: a project left naming the archive's ids is worse than one that
      // still opens on its import. Once it has begun, the import is only
      // ended again, never resumed (`markImportEnding`).
      try {
        // Before anything is written: from here on the import only ends.
        if (!record.finish.endingAsIs) await markImportEnding(client, projectId, record);
        const { rulesFailed } = await finishArchiveImport({
          client,
          projectId,
          plan: record.finish,
          warnings,
        });
        // A rule left undeclared by a failure would stay off for good.
        if (rulesFailed) return { cleared: false, warnings };
      } catch (err) {
        console.error('Could not finish the import:', err);
        return { cleared: false, warnings: [...warnings, 'The import could not be finished.'] };
      }
      return { cleared: await markImportFinished(client, projectId), warnings };
    }
    // A project igt did not set up (a native archive of another app's
    // project) gets none of igt's rules.
    if (!readInitialized(config)) {
      return { cleared: await markImportFinished(client, projectId), warnings };
    }
    const repair = importRepairs(config);
    const { notInForce } = await declareIgtRules(client, projectId, { repair });
    warnings.push(...notInForce.map((f) => notInForceText([f])));
  } catch (err) {
    console.error('Could not put the annotation rules in force:', err);
    warnings.push('The annotation rules were not set.');
  }
  return { cleared: await markImportFinished(client, projectId), warnings };
};
