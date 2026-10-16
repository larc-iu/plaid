// The write of the project's Tagsets settings (TagsetsSettings.jsx), apart
// from the screen so a script or a test can run the same batch.

// Relative imports only, as igtConstraints.js: plain node runs this too.
import { IGT_NAMESPACE, readDocumentMetadata } from './igtConfig.js';
import { getIgtLayerInfo } from './layerInfo.js';
import { governedFields, readTagsetName } from './tagsets.js';
import { igtFields, queueFieldDeclarations } from './igtConstraints.js';
import { expectStored } from '../../../plaid-ui/src/domain/configCells.js';

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
  if (renamed) {
    const named = governedFields(getIgtLayerInfo(live), live?.config).filter(
      (g) => g.tagsetName === renamed.from,
    );
    const layers = new Map(igtFields(getIgtLayerInfo(live)).map((sl) => [sl.id, sl]));
    for (const g of named) {
      if (g.kind !== 'span') continue;
      b.spanLayers.setConfig(g.layerId, IGT_NAMESPACE, 'tagset', renamed.to, undefined, {
        expected: layers.get(g.layerId)?.config?.[IGT_NAMESPACE]?.tagset ?? renamed.from,
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
