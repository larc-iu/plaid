import { useEffect, useState } from 'react';
import { governedFields, offTagsetValues, readTagsets } from '@/domain/tagsets';
import { getIgtLayerInfo } from '@/domain/layerInfo';
import { freqQueries, metadataFreqQuery } from '../search/searchQueries.js';

// Every span in a layer regardless of value (the REGEXP UDF matches on
// contains), matching the Validation tab's scan.
const ANY_VALUE = { regex: '.' };
import { TagsetsSettings } from './TagsetsSettings.jsx';
import { FieldsSettings } from './FieldsSettings.jsx';
import { DocumentMetadataSettings } from './DocumentMetadataSettings.jsx';

// Everything a tagset can govern: the interlinear tiers, the values they may
// take, the tokens that are skipped, and the fields recorded about each
// document. They belong together because they refer to each other — a field
// points at a tagset by name, and the ignored-token rule (rendered inside
// FieldsSettings) only affects Word-scope fields.
export const AnnotationSettings = ({ project, projectId, client, onProjectUpdate }) => {
  // Read here rather than in FieldsSettings: the two sections are siblings, so
  // a tagset created above has to reach the field table below without a page
  // reload, and this component is the one holding the live project.
  const tagsetNames = Object.keys(readTagsets(project?.config));

  // How many values in each governed field its tagset refuses, keyed
  // "scope:field". The same one-aggregate-query-per-field scan the Validation
  // tab runs, surfaced here because this is where you are looking when you
  // point a field at a tagset -- otherwise nothing tells you to go and check.
  // Best-effort: a failure leaves the badges off rather than blocking settings.
  const [violations, setViolations] = useState({});
  useEffect(() => {
    let cancelled = false;
    const governed = governedFields(getIgtLayerInfo(project), project?.config);
    if (!client || !governed.length) return;
    (async () => {
      const counts = {};
      await Promise.all(
        governed.map(async (g) => {
          try {
            const results = await Promise.all(
              g.kind === 'metadata'
                ? [client.query(metadataFreqQuery(projectId, g.field))]
                : freqQueries({ kind: 'span', layerId: g.layerId }, ANY_VALUE).map((q) =>
                    client.query(q),
                  ),
            );
            const attested = [];
            for (const r of results) {
              for (const [value, n] of r?.results || []) {
                if (typeof value === 'string') attested.push([value, n || 0]);
              }
            }
            counts[`${g.scope}:${g.field}`] = offTagsetValues(attested, g.tagset).length;
          } catch {
            /* leave this field unbadged */
          }
        }),
      );
      if (!cancelled) setViolations(counts);
    })();
    return () => {
      cancelled = true;
    };
  }, [client, projectId, project]);

  return (
    <div className="tw flex flex-col gap-8 pt-4 [&>*+*]:border-t [&>*+*]:pt-8">
      {/* Tagsets: the value lists the fields below can point at. Above
          Annotation Fields because a field can only reference one that
          already exists. */}
      <TagsetsSettings
        project={project}
        projectId={projectId}
        client={client}
        onProjectUpdate={onProjectUpdate}
      />

      {/* Annotation Fields, and the ignored-token rule that modifies the
          Word-scope ones. Both live in FieldsSettings and save together. */}
      <FieldsSettings
        projectId={projectId}
        client={client}
        tagsetNames={tagsetNames}
        violations={violations}
        projectId={projectId}
        onProjectUpdate={onProjectUpdate}
      />

      {/* Per-document fields (Date, Speakers, Genre). Genre and Text type are
          closed inventories far more naturally than a gloss ever is, which is
          why these take tagsets too. */}
      <DocumentMetadataSettings
        projectId={projectId}
        client={client}
        tagsetNames={tagsetNames}
        violations={violations}
      />
    </div>
  );
};
