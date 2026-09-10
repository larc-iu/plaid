// Reading a batch of .eaf files and deciding what their tiers become: the half
// of an ELAN import that is the same whether the files are becoming a new
// project or new documents in one that already exists.
//
// What differs between the two callers is what a field NAME means (a name to
// create, or one of the project's existing fields) and what happens on Import.
// Everything up to that point lives here.

import { useMemo, useState } from 'react';
import { readEaf } from '@/import/elan/readEaf';
import { compareSchemas, suggestRoles, validateRoles, ROLES } from '@/import/elan/schema';
import {
  buildElanDocuments,
  defaultFieldName,
  matchMediaFiles,
} from '@/import/elan/buildDocuments';

const EAF = /\.eaf$/i;

/** Split a picked file list into the .eaf files and everything else. */
export const partitionPicked = (fileList) => {
  const all = [...(fileList || [])];
  return { eafs: all.filter((f) => EAF.test(f.name)), media: all.filter((f) => !EAF.test(f.name)) };
};

/**
 * @param options.skipEmptyTiers  give a tier with no annotations no role. A
 *   corpus template carries tiers nobody has filled in yet, and in a project
 *   that already has its fields those would only add empty ones.
 * @param options.namesFor  (nodes, roles) => {nodeKey: fieldName} for the tiers
 *   it can place. A caller with a project in hand uses it to pre-map tiers onto
 *   the fields that project already has; anything it leaves out falls back to
 *   the tier's own name. It decides for the whole batch at once because some
 *   pairings only follow from the set (see suggestFieldNames).
 */
export function useElanBatch({ skipEmptyTiers = false, namesFor = null } = {}) {
  const [files, setFiles] = useState(null); // parsed .eaf objects
  const [mediaFiles, setMediaFiles] = useState([]);
  const [comparison, setComparison] = useState(null);
  const [nearMissChoices, setNearMissChoices] = useState({});
  const [nearMissGroups, setNearMissGroups] = useState([]);
  const [roles, setRoles] = useState({});
  const [fieldNames, setFieldNames] = useState({});

  const nodes = useMemo(() => comparison?.nodes ?? [], [comparison]);
  const problems = useMemo(
    () => (comparison?.consistent ? validateRoles(nodes, roles) : []),
    [comparison, nodes, roles],
  );

  // Which recording belongs to which .eaf, recomputed with either list.
  const media = useMemo(() => matchMediaFiles(files || [], mediaFiles), [files, mediaFiles]);

  // Re-derived whenever a mapping choice changes, so the review numbers always
  // describe what the import would actually do.
  const build = useMemo(() => {
    if (!files || !comparison?.consistent || problems.length) return null;
    try {
      return buildElanDocuments(files, nodes, roles, { fieldNames, mediaByFile: media.byFile });
    } catch (e) {
      console.error('ELAN build failed:', e);
      return null;
    }
  }, [files, comparison, nodes, roles, fieldNames, problems, media]);

  // Adopt a schema: suggest the roles and field names for it, keeping whatever
  // the user has already chosen for nodes that survive. A merge changes node
  // keys, so the mapping has to be rebuilt rather than carried over wholesale.
  const applySchema = (parsed, result) => {
    setComparison(result);
    const suggested = result.consistent ? suggestRoles(result.nodes) : {};
    const roleOf = { ...suggested };
    if (skipEmptyTiers) {
      for (const n of result.nodes) if (!n.annotationCount) roleOf[n.key] = ROLES.OFF;
    }
    setRoles((prev) => {
      const next = { ...roleOf };
      for (const n of result.nodes) if (prev[n.key] !== undefined) next[n.key] = prev[n.key];
      return next;
    });
    // Named from the SUGGESTED roles, not the ones an empty tier is forced to:
    // switching one on later should find its field already chosen.
    const placed = namesFor?.(result.nodes, suggested) ?? {};
    setFieldNames((prev) =>
      Object.fromEntries(
        result.nodes.map((n) => [n.key, prev[n.key] ?? placed[n.key] ?? defaultFieldName(n)]),
      ),
    );
  };

  /** Re-read the batch under a new set of merge decisions. */
  const chooseNearMiss = (fold, choice) => {
    const choices = { ...nearMissChoices, [fold]: choice };
    setNearMissChoices(choices);
    const canonical = new Map(
      Object.entries(choices).filter(([, v]) => v !== 'separate' && v !== undefined),
    );
    applySchema(files, compareSchemas(files, canonical.size ? canonical : null));
  };

  /**
   * Read a picked file list. Media files are kept aside; .eaf files are parsed
   * and compared. Throws with a message fit to show the user.
   */
  const readFiles = async (fileList) => {
    const { eafs, media: picked } = partitionPicked(fileList);
    // Picking the same recording twice (choosing again, or dragging a folder
    // over one already staged) must not stage it twice: the second copy would
    // find its .eaf already claimed and sit there reading "no .eaf names this
    // file". Name and size is what identifies a picked file.
    if (picked.length) {
      setMediaFiles((prev) => {
        const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
        return [...prev, ...picked.filter((f) => !seen.has(`${f.name}:${f.size}`))];
      });
    }
    if (!eafs.length) {
      if (picked.length) return false; // media added to an existing batch
      throw new Error('Choose one or more .eaf files.');
    }
    const parsed = [];
    for (const file of eafs) parsed.push(readEaf(await file.text(), file.name));
    const result = compareSchemas(parsed);
    setFiles(parsed);
    setNearMissGroups(result.nearMisses);
    setNearMissChoices({});
    applySchema(parsed, result);
    return true;
  };

  /**
   * Drop one .eaf from the batch. The schema is re-derived from what is left,
   * since a tier tree that only the removed file had is no longer part of it.
   */
  const removeEaf = (fileName) => {
    const kept = (files || []).filter((f) => f.fileName !== fileName);
    if (!kept.length) {
      setFiles(null);
      setComparison(null);
      setNearMissGroups([]);
      setNearMissChoices({});
      return;
    }
    const result = compareSchemas(kept);
    setFiles(kept);
    setNearMissGroups(result.nearMisses);
    setNearMissChoices({});
    applySchema(kept, result);
  };

  const reset = () => {
    setFiles(null);
    setComparison(null);
    setMediaFiles([]);
    setNearMissGroups([]);
    setNearMissChoices({});
  };

  return {
    files,
    mediaFiles,
    setMediaFiles,
    media,
    comparison,
    nodes,
    roles,
    fieldNames,
    build,
    problems,
    nearMissGroups,
    nearMissChoices,
    undecidedNearMisses: nearMissGroups.filter((g) => !nearMissChoices[g.fold]),
    readFiles,
    removeEaf,
    removeMedia: (file) => setMediaFiles((prev) => prev.filter((f) => f !== file)),
    chooseNearMiss,
    setRole: (key, role) => setRoles((r) => ({ ...r, [key]: role })),
    setName: (key, name) => setFieldNames((n) => ({ ...n, [key]: name })),
    reset,
  };
}
