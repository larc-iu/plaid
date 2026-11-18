// What a settings save would take into a closed list over a document metadata
// field: the values documents hold that the list does not. Core holds no rule
// on metadata, so this is asked here, before the save, as `refusedBySave`
// (domain/igtConstraints.js) asks core for annotation fields, and answered in
// its shape, so the same notice names them.

import { governedFields, tagsetEnforces, validateValue } from '@/domain/tagsets';
import { governedFreqQueries } from '../search/searchQueries.js';
import { attestedRows } from '../validate/attested.js';

/**
 * For every document metadata field `projectConfig` puts under a closed list
 * that `previousConfig` did not hold it to (a tagset newly assigned, closed,
 * or changed), the values documents hold that the list refuses. Returns
 * `[{layerId, field, noun, count, valueCount, values: [{value, parts, count}]}]`,
 * a field only when it holds any.
 */
export const refusedMetadataBySave = async (
  client,
  projectId,
  projectConfig,
  previousConfig,
  limit = 5,
) => {
  const was = new Map(
    governedFields(null, previousConfig)
      .filter((g) => g.kind === 'metadata')
      .map((g) => [g.field, JSON.stringify(g.tagset)]),
  );
  const asks = governedFields(null, projectConfig)
    .filter(
      (g) =>
        g.kind === 'metadata' &&
        tagsetEnforces(g.tagset) &&
        was.get(g.field) !== JSON.stringify(g.tagset),
    )
    .map(async (g) => {
      const res = await client.query(governedFreqQueries(g, projectId)[0]);
      const bad = attestedRows(g, res?.results)
        .map(([value, count]) => ({
          value,
          count,
          parts: validateValue(value, g.tagset).map((v) => v.part),
        }))
        .filter((v) => v.parts.length)
        .sort((a, b) => b.count - a.count);
      return {
        layerId: g.key,
        field: g.field,
        noun: 'document',
        count: bad.reduce((n, v) => n + v.count, 0),
        valueCount: bad.length,
        values: bad.slice(0, limit),
      };
    });
  return (await Promise.all(asks)).filter((r) => r.count > 0);
};
