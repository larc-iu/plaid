import { declareIgtRules } from '@/domain/igtConstraints';
import { humanizeError, notifyError, notifyWarning } from '@/utils/feedback';
import { NOT_IN_FORCE_TITLE, notInForceText } from './refusedValues.js';

/**
 * After a save of tagsets or fields: every field's rules on the server made
 * what its settings want (`declareIgtRules`), read fresh, so a field another
 * maintainer pointed at a tagset while this save was on its way, or one an
 * unfinished import or a script left behind, is brought in line too. A list
 * the stored values break stays out of force, and a notice names its values.
 * The save has landed whatever this answers. Returns the fields left out of
 * force, or null when the declaration failed.
 */
export const putRulesInForce = async (client, projectId) => {
  try {
    const { notInForce } = await declareIgtRules(client, projectId, { fieldsOnly: true });
    if (notInForce.length) notifyWarning(notInForceText(notInForce), NOT_IN_FORCE_TITLE);
    return notInForce;
  } catch (err) {
    console.error('Could not put the field rules in force:', err);
    notifyError(humanizeError(err), 'Failed to put the rules in force');
    return null;
  }
};
