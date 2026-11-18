// The write of UD's vocabulary settings, the one way both the Customization
// tab and the Validation tab's Add write them.

// Relative imports only, as udConstraints.js, so plain node can load it.
import { expectStored, storedConfig } from '../../../plaid-ui/src/domain/configCells.js';
import { UD_NAMESPACE } from './udConfig.js';
import { getUdLayerInfo } from '../utils/udLayerUtils.js';
import { queueRuleChanges, withConfigWrites } from '../utils/udConstraints.js';
import { ruleCellSibling, unstoredClosedLists } from '../utils/udVocab.js';

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
 * A closed list's rule is made of two cells of its layer, the list and its
 * mode (ruleCellSibling). For each of those `cells` writes without the other,
 * the other as `entity` holds it, so that a save elsewhere of the other since
 * (a list closed there, a tag added there) refuses this one (409) instead of
 * leaving a rule one of them never saw (H3-7-6).
 */
const ruleSiblings = (project, cells) => {
  const info = getUdLayerInfo(project);
  const out = [];
  for (const c of cells) {
    const key = ruleCellSibling(info, c.entity, c.key);
    const has = (x) => x.entity.id === c.entity.id && x.key === key;
    if (!key || cells.some(has) || out.some(has)) continue;
    out.push({ bundle: c.bundle, entity: c.entity, key });
  }
  return out;
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
  // Each as it was read: a write of the value read, or a delete of a cell
  // read absent, changes nothing and refuses the batch if the cell moved.
  for (const c of ruleSiblings(project, cells)) {
    const read = storedConfig(c.entity, UD_NAMESPACE, c.key);
    if (read === undefined) {
      b[c.bundle].deleteConfig(c.entity.id, UD_NAMESPACE, c.key, undefined, { expected: null });
    } else {
      b[c.bundle].setConfig(c.entity.id, UD_NAMESPACE, c.key, read, undefined, { expected: read });
    }
  }
  queueRuleChanges(b, getUdLayerInfo(project), after);
};
