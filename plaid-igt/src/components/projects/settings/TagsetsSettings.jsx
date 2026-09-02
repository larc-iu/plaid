import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { TagsetsManager } from './TagsetsManager.jsx';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { IGT_NAMESPACE } from '@/domain/igtConfig';
import { getIgtLayerInfo } from '@/domain/layerInfo';
import { readTagsets, readTagsetName } from '@/domain/tagsets';
import { freqQueries } from '../search/searchQueries.js';

// Every span in a layer, regardless of value. The REGEXP UDF matches on
// CONTAINS (plaid-core sql/query/exec.clj), so "." means "has at least one
// character" — the same spec the orthography usage count uses. Clearing a cell
// deletes its span (domain/mutations/spans.js), so no real annotation has an
// empty value to miss.
const ANY_VALUE = { regex: '.' };

export const TagsetsSettings = ({ projectId, client, onProjectUpdate }) => {
  const [tagsets, setTagsets] = useState(null);
  const [usage, setUsage] = useState({});
  const [spanLayersByTagset, setSpanLayersByTagset] = useState({});
  const [hasError, setHasError] = useState(false);

  const load = useCallback(async () => {
    try {
      setHasError(false);
      if (!client) throw new Error('Not authenticated');
      const project = await client.projects.get(projectId);
      const info = getIgtLayerInfo(project);

      // Which fields point at which tagset. Both the delete warning and the
      // attested-value queries are driven off this, so it is collected once.
      const byName = {};
      const layersByName = {};
      for (const [scope, layers] of Object.entries(info.spanLayers || {})) {
        for (const sl of layers || []) {
          const name = readTagsetName(sl.config);
          if (!name) continue;
          (byName[name] ||= []).push({ scope, name: sl.name, id: sl.id });
          (layersByName[name] ||= []).push(sl.id);
        }
      }
      setUsage(byName);
      setSpanLayersByTagset(layersByName);
      setTagsets(readTagsets(project.config));
    } catch (error) {
      console.error('Failed to load tagsets:', error);
      setHasError(true);
    }
  }, [client, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSaveChanges = async (next) => {
    try {
      if (!client) throw new Error('Not authenticated');
      await client.projects.setConfig(projectId, IGT_NAMESPACE, 'tagsets', next);
      setTagsets(next);
      notifySuccess('Tagsets have been updated', 'Settings Saved');
      // Field references are read at load time, so pick up a rename's effect on
      // the "used by" line without a page refresh.
      load();
      // And refresh the project itself, since the field table below reads the
      // tagset names off it: without this a tagset created here does not become
      // pickable until a page reload.
      onProjectUpdate?.();
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
    const layerIds = spanLayersByTagset[name] || [];
    if (!layerIds.length) return [];
    const results = await Promise.all(
      layerIds.flatMap((layerId) =>
        freqQueries({ kind: 'span', layerId }, ANY_VALUE).map((q) => client.query(q)),
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

  if (hasError) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-4">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
          <div>
            <p className="text-sm font-medium text-destructive">Configuration Error</p>
            <p className="text-sm text-muted-foreground">
              Failed to load or save tagsets. Please refresh the page and try again.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-lg font-semibold">Tagsets</h2>
      <p className="mb-4 mt-1 text-sm text-muted-foreground">
        Controlled vocabularies for annotation values. A tagset lists the tags an annotation field
        may use, and any number of fields can share one. The same list usually governs Gloss at both
        Word and Morpheme scope. Point a field at a tagset in Annotation Fields below. This is
        unrelated to Vocabularies, which hold lexicon entries that words link to.
      </p>

      {tagsets === null ? (
        <div className="rounded-lg border p-4 text-sm text-muted-foreground">Loading tagsets…</div>
      ) : (
        <TagsetsManager
          tagsets={tagsets}
          usage={usage}
          onSaveChanges={handleSaveChanges}
          onLoadAttested={handleLoadAttested}
        />
      )}
    </div>
  );
};
