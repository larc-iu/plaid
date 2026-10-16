import { declareIgtRules } from '@/domain/igtConstraints';
import { humanizeError, notifyError, notifyWarning } from '@/utils/feedback';
import { NOT_IN_FORCE_TITLE, notInForceText } from './refusedValues.js';

/**
 * After a save of tagsets or fields: every field's rules on the server made
 * what its settings want (`declareIgtRules`), read fresh, so a field another
 * maintainer pointed at a tagset while this save was on its way, or one an
 * unfinished import or a script left behind, is brought in line too. No
 * annotation is changed: a list the stored values break stays out of force,
 * and so does a rule only a repair would bring in, and a notice names them.
 * The save has landed whatever this answers. Returns the fields left out of
 * force, or null when the declaration failed.
 *
 * Options: `layers`, a test of a layer id, to put only those fields in
 * force. `quiet`, to leave the notice to the caller. `named`, fields an
 * earlier call left out, said in the same notice. `here`, when the notice
 * shows on Validation itself.
 */
export const putRulesInForce = async (
  client,
  projectId,
  { layers = null, quiet = false, named = [], here = false } = {},
) => {
  let notInForce;
  try {
    ({ notInForce } = await declareIgtRules(client, projectId, {
      fieldsOnly: true,
      repair: false,
      layers,
    }));
  } catch (err) {
    console.error('Could not put the field rules in force:', err);
    notifyError(humanizeError(err), 'Failed to put the rules in force');
    return null;
  }
  const all = [...named, ...notInForce];
  if (!quiet && all.length) notifyWarning(notInForceText(all, { here }), NOT_IN_FORCE_TITLE);
  return all;
};
