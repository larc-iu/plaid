// The write of UD's vocabulary settings, the one way both the Customization
// tab and the Validation tab's Add write them.

// Relative imports only, as udConstraints.js, so plain node can load it.
import { expectStored } from '../../../plaid-ui/src/domain/configCells.js';
import { UD_NAMESPACE } from './udConfig.js';
import { getUdLayerInfo } from '../utils/udLayerUtils.js';
import { queueRuleChanges, withConfigWrites } from '../utils/udConstraints.js';

/**
 * Queue on batch `b` the config cells `cells` (`{bundle, entity, key, value}`,
 * each under `ud`) of `project`, each expecting what `entity` holds, so a save
 * made elsewhere since refuses the batch (409). A closed list is a rule its
 * layer holds on the server, so the layers whose rules the cells change take
 * them in the same batch, and a list the stored values break is refused
 * whole.
 */
export const queueVocabCells = (b, project, cells) => {
  const after = getUdLayerInfo(withConfigWrites(project, cells));
  for (const c of cells) {
    b[c.bundle].setConfig(
      c.entity.id,
      UD_NAMESPACE,
      c.key,
      c.value,
      undefined,
      expectStored(c.entity, UD_NAMESPACE, c.key),
    );
  }
  queueRuleChanges(b, getUdLayerInfo(project), after);
};
