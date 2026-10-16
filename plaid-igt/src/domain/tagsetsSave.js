// The write of the project's Tagsets settings (TagsetsSettings.jsx), apart
// from the screen so a script or a test can run the same batch.

// Relative imports only, as igtConstraints.js: plain node runs this too.
import { IGT_NAMESPACE, readDocumentMetadata } from './igtConfig.js';
import { getIgtLayerInfo } from './layerInfo.js';
import { governedFields, readTagsetName } from './tagsets.js';
import { igtFields, queueFieldDeclarations } from './igtConstraints.js';
import {
  expectStored,
  isConfigConflict,
  sameConfig,
  storedConfig,
} from '../../../plaid-ui/src/domain/configCells.js';

/** What a save that read the tagsets says when they changed before it landed. */
export const TAGSETS_CHANGED = 'Tagsets changed elsewhere. Reload and redo your change.';

/**
 * Queue on `api` (a batch's `projects`, `spanLayers` or `vocabLayers`) a
 * write that changes nothing and states that the IGT cell `key` of `id`
 * still holds `read` (undefined: absent, null: a stored JSON null). Core
 * writes nothing for it and refuses the whole batch (409) when the cell
 * changed since.
 */
export const queueStated = (api, id, key, read) =>
  read === undefined
    ? api.deleteConfig(id, IGT_NAMESPACE, key, undefined, { expected: null })
    : api.setConfig(id, IGT_NAMESPACE, key, read, undefined, { expected: read });

/**
 * A save's refusal as the screen says it: a 409 of a save that stated the
 * tagsets it read (`read`, as stored) is TAGSETS_CHANGED when the tagsets
 * `readNow()` finds are others (marked `tagsetsChanged`), and `error` itself
 * otherwise.
 */
export const tagsetsChangedError = async (error, read, readNow) => {
  if (!isConfigConflict(error)) return error;
  let now;
  try {
    now = await readNow();
  } catch {
    return error;
  }
  if (sameConfig(now ?? null, read ?? null)) return error;
  return Object.assign(new Error(TAGSETS_CHANGED, { cause: error }), { tagsetsChanged: true });
};

/**
 * What a Tagsets save of `next` over `live` (the project as the save read
 * it) does to the fields: `fields`, every IGT field as it will be after the
 * save (a field naming the renamed tagset read under its new name, with
 * `configBefore`), and `after`, the project config after it. `renamed` is
 * `{from, to}` or null. What `refusedBySave` and `queueTagsetsSave` take.
 */
export const tagsetsSaveFields = (live, next, renamed = null) => {
  const fields = igtFields(getIgtLayerInfo(live)).map((sl) =>
    renamed && readTagsetName(sl.config) === renamed.from
      ? {
          ...sl,
          configBefore: sl.config,
          config: {
            ...sl.config,
            [IGT_NAMESPACE]: { ...sl.config?.[IGT_NAMESPACE], tagset: renamed.to },
          },
        }
      : sl,
  );
  const after = {
    ...live?.config,
    [IGT_NAMESPACE]: { ...live?.config?.[IGT_NAMESPACE], tagsets: next },
  };
  return { fields, after };
};

/**
 * Queue on batch `b` a Tagsets save: the tagsets `next` (expecting
 * `expected`, the tagsets the page read), every field that names a renamed
 * tagset pointed at its new name, and the rules of each field in force whose
 * rules the save changes (`queueFieldDeclarations`). All in one batch, so no
 * read ever sees a field naming a tagset that is gone, and a field another
 * maintainer pointed elsewhere since `live` was read refuses the whole save.
 * A save that renames or deletes a tagset also states every other field's
 * tagset as `live` read it (`queueStated`), so a field pointed at that
 * tagset since refuses the save too.
 * `fields` and `after` are `tagsetsSaveFields(live, next, renamed)`.
 * Returns how many fields it repointed.
 */
export const queueTagsetsSave = (
  b,
  projectId,
  live,
  next,
  { renamed = null, expected, fields, after },
) => {
  b.projects.setConfig(projectId, IGT_NAMESPACE, 'tagsets', next, undefined, { expected });
  let repointed = 0;
  const layers = igtFields(getIgtLayerInfo(live));
  const named = renamed
    ? governedFields(getIgtLayerInfo(live), live?.config).filter(
        (g) => g.tagsetName === renamed.from,
      )
    : [];
  const repointedIds = new Set(named.filter((g) => g.kind === 'span').map((g) => g.layerId));
  const removesName = Object.keys(storedConfig(live, IGT_NAMESPACE, 'tagsets') || {}).some(
    (name) => !Object.hasOwn(next || {}, name),
  );
  if (removesName) {
    for (const sl of layers) {
      if (!repointedIds.has(sl.id)) {
        queueStated(b.spanLayers, sl.id, 'tagset', storedConfig(sl, IGT_NAMESPACE, 'tagset'));
      }
    }
    if (!named.some((g) => g.kind === 'metadata')) {
      queueStated(
        b.projects,
        projectId,
        'documentMetadata',
        storedConfig(live, IGT_NAMESPACE, 'documentMetadata'),
      );
    }
  }
  if (renamed) {
    const byId = new Map(layers.map((sl) => [sl.id, sl]));
    for (const g of named) {
      if (g.kind !== 'span') continue;
      b.spanLayers.setConfig(g.layerId, IGT_NAMESPACE, 'tagset', renamed.to, undefined, {
        expected: byId.get(g.layerId)?.config?.[IGT_NAMESPACE]?.tagset ?? renamed.from,
      });
    }
    if (named.some((g) => g.kind === 'metadata')) {
      const meta = (readDocumentMetadata(live?.config) || []).map((f) =>
        f.tagset === renamed.from ? { ...f, tagset: renamed.to } : f,
      );
      b.projects.setConfig(
        projectId,
        IGT_NAMESPACE,
        'documentMetadata',
        meta,
        undefined,
        expectStored(live, IGT_NAMESPACE, 'documentMetadata'),
      );
    }
    repointed = named.length;
  }
  queueFieldDeclarations(b, fields, after, live?.config);
  return repointed;
};
