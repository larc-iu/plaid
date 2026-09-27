import { useMemo, useState } from 'react';
import { TagsetsManager } from './TagsetsManager.jsx';
import { notifyError } from '@/utils/feedback';
import { IGT_NAMESPACE, readDocumentMetadata } from '@/domain/igtConfig';
import { getIgtLayerInfo } from '@/domain/layerInfo';
import { byTagsetName, governedFields, readTagsets } from '@/domain/tagsets';
import { loadAttested, mergeAttested } from '../validate/attested.js';

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

  // Fields reference a tagset by name, so a rename has to repoint every field
  // that used the old name — annotation fields on their span layer, metadata
  // fields in the project config — or they all quietly fall back to free.
  const repointFields = async ({ from, to }) => {
    const fields = byName[from] || [];
    for (const g of fields) {
      if (g.kind === 'span') {
        await client.spanLayers.setConfig(g.layerId, IGT_NAMESPACE, 'tagset', to);
      }
    }
    if (fields.some((g) => g.kind === 'metadata')) {
      const meta = (readDocumentMetadata(project?.config) || []).map((f) =>
        f.tagset === from ? { ...f, tagset: to } : f,
      );
      await client.projects.setConfig(projectId, IGT_NAMESPACE, 'documentMetadata', meta);
    }
  };

  // Only a refused tagsets write throws, so the editor rolls back. When the
  // rename lands and repointing its fields is refused, the server holds the new
  // name, so the editor must show that rather than roll back to a name that is
  // gone. The vocabulary screen's handleSaveTagsets keeps the same contract.
  const handleSaveChanges = async (next, meta) => {
    try {
      if (!client) throw new Error('Not authenticated');
      await client.projects.setConfig(projectId, IGT_NAMESPACE, 'tagsets', next);
    } catch (error) {
      console.error('Failed to save tagsets:', error);
      notifyError(error, 'Failed to save the tagsets');
      throw error;
    }
    // Hold what we just wrote until the refreshed project comes back, so the
    // editor does not flicker to the pre-save value in between.
    setDraftTagsets(next);
    if (meta?.renamed) {
      try {
        await repointFields(meta.renamed);
      } catch (error) {
        console.error('Failed to repoint fields:', error);
        notifyError(
          `Some fields still name the tagset “${meta.renamed.from}”.`,
          'Failed to update the fields',
        );
      }
    }
    // The field table below reads the tagset names off the project, so a new
    // tagset is not pickable until this lands.
    try {
      await onProjectUpdate?.();
    } finally {
      setDraftTagsets(null);
    }
  };

  // The [value, count, reading] rows actually present in the fields using
  // this tagset, merged (see attested.js). One aggregate query per field: the server returns the field's whole
  // value inventory, so nothing has to load a document to find out what is
  // there. This is what the seed button and (later) the violations view read.
  const handleLoadAttested = async (name) => {
    const fields = byName[name] || [];
    if (!fields.length) return [];
    return mergeAttested(await Promise.all(fields.map((g) => loadAttested(client, projectId, g))));
  };

  return (
    <div>
      <h2 className="text-lg font-semibold">Tagsets</h2>
      <p className="mb-4 mt-1 text-sm text-muted-foreground">
        A tagset is the list of tags a field may use, such as Leipzig glossing abbreviations for
        Gloss or a part of speech inventory. Assign it to a field under Annotation fields below. The
        lexicon is under Vocabularies, not here.
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
