// What a settings save would newly take into a closed list over a document
// metadata field: the values documents hold that the list refuses and the
// previous settings did not. Core holds no rule on metadata, so this is asked
// here, before the save, as `refusedBySave` (igtConstraints.js) asks core for
// annotation fields, and answered in its shape, so the same notice names them.
// The Tagsets and Document metadata settings and the assistant's tagset plan
// (tagsetPlan.js) ask it.

// Relative imports only: the assistant's tests run tagsetPlan.js from node.
import { governedFields, tagsetEnforces, validateValue } from './tagsets.js';

/**
 * [value, count] rows for one document-metadata field, project-wide.
 *
 * `field` is interpolated into a dot-path, and the query parser splits field
 * references on ".", so a name containing one would silently group by nothing.
 * DocumentMetadataManager rejects periods in field names for this reason.
 */
export const metadataFreqQuery = (projectId, field) => ({
  scope: { projectIds: [projectId] },
  where: [['document', '?d', { metadata: { [field]: { regex: '.' } } }]],
  return: { group: [`?d.metadata.${field}`], aggregates: [['count']] },
});

const metadataFields = (config) =>
  governedFields(null, config).filter((g) => g.kind === 'metadata');

// The parts of `value` that `tagset` refuses, none when it does not enforce.
const refusedParts = (value, tagset) =>
  tagsetEnforces(tagset) ? validateValue(value, tagset).map((v) => v.part) : [];

/**
 * For every document metadata field `projectConfig` puts under a closed list,
 * the values documents hold that the list refuses and `previousConfig` let
 * stand. A value the previous list already refused is not counted: it holds
 * up no save, as core does not for an annotation field. Returns
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
  const was = new Map(metadataFields(previousConfig).map((g) => [g.field, g.tagset]));
  const asks = metadataFields(projectConfig)
    .filter(
      (g) =>
        tagsetEnforces(g.tagset) && JSON.stringify(was.get(g.field)) !== JSON.stringify(g.tagset),
    )
    .map(async (g) => {
      const res = await client.query(metadataFreqQuery(projectId, g.field));
      const bad = (res?.results || [])
        .filter(([value]) => typeof value === 'string')
        .map(([value, count]) => ({
          value,
          count: count || 0,
          parts: refusedParts(value, g.tagset),
        }))
        .filter((v) => v.parts.length && !refusedParts(v.value, was.get(g.field)).length)
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
