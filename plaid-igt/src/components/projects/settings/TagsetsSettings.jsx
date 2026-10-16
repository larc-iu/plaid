import { useMemo, useState } from 'react';
import { TagsetsManager } from './TagsetsManager.jsx';
import { notifyError } from '@/utils/feedback';
import { IGT_NAMESPACE } from '@/domain/igtConfig';
import { getIgtLayerInfo } from '@/domain/layerInfo';
import { byTagsetName, governedFields, readTagsets } from '@/domain/tagsets';
import { refusedBySave, tagsetRefusal } from '@/domain/igtConstraints';
import { queueTagsetsSave, tagsetsSaveFields } from '@/domain/tagsetsSave';
import { loadAttested, mergeAttested } from '../validate/attested.js';
import { isConfigConflict, storedConfig } from '@ui/domain/configCells.js';
import { useConfigCell } from '@ui/hooks/useConfigCell.js';
import { TYPE } from '@ui/lib/typeScale.js';
import { putRulesInForce } from './putRulesInForce.js';

// Everything here is derived from the LIVE project rather than a private fetch.
// `usage` (which fields point at which tagset) changes when the field table
// below is edited, so a private copy went stale the moment someone set a tagset
// on a field: the seed button stayed disabled until a page reload.
// AnnotationSettings holds the project and onProjectUpdate refreshes it, so both
// sections now read the same object and each other's edits land immediately.
export const TagsetsSettings = ({ project, projectId, client, onProjectUpdate }) => {
  const [draftTagsets, setDraftTagsets] = useState(null);
  // Each write expects the tagsets this page last read or wrote, so a page
  // opened before another maintainer's save is refused rather than writing
  // over it.
  const tagsetsCell = useConfigCell(storedConfig(project, IGT_NAMESPACE, 'tagsets'));

  const tagsets = draftTagsets ?? readTagsets(project?.config);

  // Which fields point at which tagset. Both the delete warning and the
  // attested-value queries are driven off this, so it is collected once.
  // Which fields use which tagset, from the one place that answers that.
  const byName = useMemo(
    () => byTagsetName(governedFields(getIgtLayerInfo(project), project?.config)),
    [project],
  );

  // A refused save throws, so the editor rolls back. Fields reference a
  // tagset by name, so a rename repoints every field that names it
  // (annotation fields on their span layer, metadata fields in the project
  // config) in the same batch as the tagsets: a field never names a tagset
  // that is gone, which the heal of another save would read as no list.
  const handleSaveChanges = async (next, meta) => {
    // The fields and their rules as they are now: another maintainer may
    // have pointed a field at a tagset since this page was read, and the
    // tagsets write's own check does not cover a field's reference.
    let live;
    let renamed;
    let fields;
    let after;
    let repointed = 0;
    try {
      if (!client) throw new Error('Not authenticated');
      live = await client.projects.get(projectId);
      // A closed tagset's list is a rule its fields hold on the server. The
      // fields take the new rules in the same batch as the tagsets, so a list
      // the stored values break is refused whole. A renamed tagset's fields
      // are read under the new name.
      renamed = meta?.renamed ?? null;
      ({ fields, after } = tagsetsSaveFields(live, next, renamed));
      // A closed list the stored values break would be refused whole: ask
      // first, and the editor says which values are in the way.
      const refused = await refusedBySave(client, fields, after, live?.config);
      if (refused.length) {
        throw Object.assign(new Error('Values in use are not in the list'), {
          refusedValues: refused,
        });
      }
      await tagsetsCell.write(async (expected) => {
        await client.batched((b) => {
          repointed = queueTagsetsSave(b, projectId, live, next, {
            renamed,
            expected,
            fields,
            after,
          });
        });
        return next;
      });
    } catch (error) {
      if (error?.refusedValues) throw error;
      console.error('Failed to save tagsets:', error);
      notifyError(tagsetRefusal(error) ?? error, 'Failed to save the tagsets');
      // Someone else saved since: show what is stored now.
      if (isConfigConflict(error)) {
        Promise.resolve(onProjectUpdate?.()).catch((err) =>
          console.error('Failed to reload the project:', err),
        );
      }
      throw error;
    }
    // Hold what we just wrote until the refreshed project comes back, so the
    // editor does not flicker to the pre-save value in between.
    setDraftTagsets(next);
    // Every field's rules as the settings now want them, read after the
    // save: a field pointed at a tagset since `live` was read takes its list
    // here.
    await putRulesInForce(client, projectId);
    // The field table below reads the tagset names off the project, so a new
    // tagset is not pickable until this lands.
    try {
      await onProjectUpdate?.();
    } finally {
      setDraftTagsets(null);
    }
    return { repointed };
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
      <h2 className={TYPE.card}>Tagsets</h2>
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
