import { useMemo, useState } from 'react';
import { TagsetsManager } from './TagsetsManager.jsx';
import { notifyError } from '@/utils/feedback';
import { IGT_NAMESPACE } from '@/domain/igtConfig';
import { getIgtLayerInfo } from '@/domain/layerInfo';
import { byTagsetName, governedFields, readTagsets } from '@/domain/tagsets';
import { freqQueries, metadataFreqQuery } from '../search/searchQueries.js';

// Every span in a layer, regardless of value. The REGEXP UDF matches on
// CONTAINS (plaid-core sql/query/exec.clj), so "." means "has at least one
// character" — the same spec the orthography usage count uses. Clearing a cell
// deletes its span (domain/mutations/spans.js), so no real annotation has an
// empty value to miss.
const ANY_VALUE = { regex: '.' };

// Everything here is derived from the LIVE project rather than a private fetch.
// `usage` (which fields point at which tagset) changes when the field table
// below is edited, so a private copy went stale the moment someone set a tagset
// on a field: the seed button stayed disabled until a page reload.
// AnnotationSettings holds the project and onProjectUpdate refreshes it, so both
// sections now read the same object and each other's edits land immediately.
export const TagsetsSettings = ({ project, projectId, client, onProjectUpdate }) => {
  const [draftTagsets, setDraftTagsets] = useState(null);

  const tagsets = draftTagsets ?? readTagsets(project?.config);

  // Which fields point at which tagset. Both the delete warning and the
  // attested-value queries are driven off this, so it is collected once.
  // Which fields use which tagset, from the one place that answers that.
  const byName = useMemo(
    () => byTagsetName(governedFields(getIgtLayerInfo(project), project?.config)),
    [project],
  );

  const handleSaveChanges = async (next) => {
    try {
      if (!client) throw new Error('Not authenticated');
      await client.projects.setConfig(projectId, IGT_NAMESPACE, 'tagsets', next);
      // Hold what we just wrote until the refreshed project comes back, so the
      // editor does not flicker to the pre-save value in between.
      setDraftTagsets(next);
      // The field table below reads the tagset names off the project, so a new
      // tagset is not pickable until this lands.
      await onProjectUpdate?.();
      setDraftTagsets(null);
    } catch (error) {
      console.error('Failed to save tagsets:', error);
      notifyError('Failed to save tagsets', 'Save Error');
      throw error;
    }
  };

  // The [value, count] rows actually present in the fields using this tagset,
  // merged. One aggregate query per field: the server returns the field's whole
  // value inventory, so nothing has to load a document to find out what is
  // there. This is what the seed button and (later) the violations view read.
  const handleLoadAttested = async (name) => {
    const fields = byName[name] || [];
    if (!fields.length) return [];
    const results = await Promise.all(
      fields.flatMap((g) =>
        g.kind === 'metadata'
          ? [client.query(metadataFreqQuery(projectId, g.field))]
          : freqQueries({ kind: 'span', layerId: g.layerId }, ANY_VALUE).map((q) =>
              client.query(q),
            ),
      ),
    );
    const counts = new Map();
    for (const r of results) {
      for (const [value, n] of r?.results || []) {
        if (typeof value !== 'string') continue;
        counts.set(value, (counts.get(value) || 0) + (n || 0));
      }
    }
    return [...counts.entries()];
  };

  return (
    <div>
      <h2 className="text-lg font-semibold">Tagsets</h2>
      <p className="mb-4 mt-1 text-sm text-muted-foreground">
        Controlled vocabularies for annotation values. A tagset lists the tags an annotation field
        may use, and any number of fields can share one. The same list usually governs Gloss at both
        Word and Morpheme scope. Point a field at a tagset in Annotation Fields below. This is
        unrelated to Vocabularies, which hold lexicon entries that words link to.
      </p>

      <TagsetsManager
        tagsets={tagsets}
        usage={byName}
        onSaveChanges={handleSaveChanges}
        onLoadAttested={handleLoadAttested}
      />
    </div>
  );
};
