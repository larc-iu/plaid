// The write of UD's vocabulary settings, the one way both the Customization
// tab and the Validation tab's Add write them.

// Relative imports only, as udConstraints.js, so plain node can load it.
import { expectStored } from '../../../plaid-ui/src/domain/configCells.js';
import { UD_NAMESPACE } from './udConfig.js';
import { getUdLayerInfo } from '../utils/udLayerUtils.js';
import { queueRuleChanges, withConfigWrites } from '../utils/udConstraints.js';
import { unstoredClosedLists } from '../utils/udVocab.js';

/**
 * The cells that store each list `cells` leave closed with nothing stored,
 * as the page shows it (REV-TR-1), so the stored list, the page, the
 * assistant and core's rule are read from one value. An open list with
 * nothing stored keeps following the shipped default. A list closed before
 * this was stored is stored by its project's next settings save, whatever
 * that save changes, and queueRuleChanges declares its rule again.
 */
const closedListCells = (project, cells) => {
  const before = getUdLayerInfo(project);
  return unstoredClosedLists(getUdLayerInfo(withConfigWrites(project, cells))).map(
    ({ layer, ...c }) => ({ ...c, entity: before[layer] }),
  );
};

/**
 * Queue on batch `b` the config cells `cells` (`{bundle, entity, key, value}`,
 * each under `ud`) of `project`, each expecting what `entity` holds, so a save
 * made elsewhere since refuses the batch (409). A closed list is a rule its
 * layer holds on the server, so the layers whose rules the cells change take
 * them in the same batch, and a list the stored values break is refused
 * whole.
 */
export const queueVocabCells = (b, project, given) => {
  const cells = [...given, ...closedListCells(project, given)];
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
