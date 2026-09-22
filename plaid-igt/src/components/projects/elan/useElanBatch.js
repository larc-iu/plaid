// Reading a batch of .eaf files and deciding what their tiers become: the half
// of an ELAN import that is the same whether the files are becoming a new
// project or new documents in one that already exists.
//
// What differs between the two callers is what a field NAME means (a name to
// create, or one of the project's existing fields) and what happens on Import.
// Everything up to that point lives here.

import { useMemo, useRef, useState } from 'react';
import { readEaf } from '@/import/elan/readEaf';
import {
  compareSchemas,
  suggestRoles,
  validateRoles,
  ROLES,
  SCOPE_OF_ROLE,
} from '@/import/elan/schema';
import {
  buildElanDocuments,
  defaultFieldName,
  matchMediaFiles,
} from '@/import/elan/buildDocuments';
import { fieldWorksFieldNames } from '@/import/elan/tierNaming';

const EAF = /\.eaf$/i;

/** Split a picked file list into the .eaf files and everything else. */
export const partitionPicked = (fileList) => {
  const all = [...(fileList || [])];
  return { eafs: all.filter((f) => EAF.test(f.name)), media: all.filter((f) => !EAF.test(f.name)) };
};

/** One entry per node in a field role, as the tier-naming helpers take them. */
export const fieldTierEntries = (nodes, roles) =>
  nodes
    .map((node) => ({
      key: node.key,
      name: defaultFieldName(node),
      scope: SCOPE_OF_ROLE[roles[node.key]],
    }))
    .filter((e) => e.scope);

// A new project's fields: a FieldWorks-shaped tier is named as the FLEx
// importer would name the field, anything else after the tier.
const newFieldNames = (nodes, roles) => fieldWorksFieldNames(fieldTierEntries(nodes, roles));

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
export function useElanBatch({ skipEmptyTiers = false, namesFor = newFieldNames } = {}) {
  const [files, setFiles] = useState(null); // parsed .eaf objects
  const [mediaFiles, setMediaFiles] = useState([]);
  const [comparison, setComparison] = useState(null);
  const [nearMissChoices, setNearMissChoices] = useState({});
  const [nearMissGroups, setNearMissGroups] = useState([]);
  const [roles, setRoles] = useState({});
  const [fieldNames, setFieldNames] = useState({});
  const [recordMediaName, setRecordMediaName] = useState(true);
  // The mapping a resumed import was answered with the first time, kept for
  // every re-derivation of the schema and not just the first. A merge
  // decision and a removed .eaf both rebuild the node keys the record's
  // answers are filed under, so a rebuild that forgets them re-suggests the
  // mapping and the hand-mapped tiers go with it.
  const givenRef = useRef(null);

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
      return buildElanDocuments(files, nodes, roles, {
        fieldNames,
        mediaByFile: media.byFile,
        recordMediaName,
      });
    } catch (e) {
      console.error('ELAN build failed:', e);
      return null;
    }
  }, [files, comparison, nodes, roles, fieldNames, problems, media, recordMediaName]);

  // Adopt a schema: suggest the roles and field names for it, keeping whatever
  // the user has already chosen for nodes that survive. A merge changes node
  // keys, so the mapping has to be rebuilt rather than carried over wholesale.
  //
  // `given` is the mapping a resumed import was answered with the first time.
  // It wins over both the suggestion and anything chosen since, for every tier
  // still in the batch: the resume redoes the documents the first run did not
  // finish, and a re-suggested role would import them under a mapping nobody
  // made. A tier the batch no longer has is dropped.
  const applySchema = (parsed, result, given = null) => {
    setComparison(result);
    const suggested = result.consistent ? suggestRoles(result.nodes) : {};
    const roleOf = { ...suggested };
    if (skipEmptyTiers) {
      for (const n of result.nodes) if (!n.annotationCount) roleOf[n.key] = ROLES.OFF;
    }
    const here = new Set(result.nodes.map((n) => n.key));
    const kept = (record, valid) =>
      Object.fromEntries(
        Object.entries(record || {}).filter(([key, value]) => here.has(key) && valid(value)),
      );
    const givenRoles = kept(given?.roles, (r) => Object.values(ROLES).includes(r));
    const givenNames = kept(given?.fieldNames, (n) => typeof n === 'string' && n.length > 0);
    setRoles((prev) => {
      const next = { ...roleOf };
      for (const n of result.nodes) if (prev[n.key] !== undefined) next[n.key] = prev[n.key];
      return { ...next, ...givenRoles };
    });
    // Named from the SUGGESTED roles, not the ones an empty tier is forced to:
    // switching one on later should find its field already chosen.
    const placed = namesFor?.(result.nodes, suggested) ?? {};
    setFieldNames((prev) =>
      Object.fromEntries(
        result.nodes.map((n) => [
          n.key,
          givenNames[n.key] ?? prev[n.key] ?? placed[n.key] ?? defaultFieldName(n),
        ]),
      ),
    );
  };

  // The tiers a set of merge decisions folds together, as compareSchemas takes
  // them: null when nothing has been decided.
  const canonicalOf = (choices) => {
    const merged = new Map(
      Object.entries(choices || {}).filter(([, v]) => v !== 'separate' && v !== undefined),
    );
    return merged.size ? merged : null;
  };

  // Take a parsed batch, under the answers a resume was given (or none).
  // The near misses are what the batch reads like before any of them is
  // decided, so they are found first and the merge applied over the top.
  const adoptBatch = (parsed, given) => {
    givenRef.current = given ?? null;
    const result = compareSchemas(parsed);
    setFiles(parsed);
    setNearMissGroups(result.nearMisses);
    const merges = given?.nearMissChoices ?? {};
    setNearMissChoices(merges);
    const canonical = canonicalOf(merges);
    applySchema(parsed, canonical ? compareSchemas(parsed, canonical) : result, given);
    if (typeof given?.recordMediaName === 'boolean') setRecordMediaName(given.recordMediaName);
  };

  /** Re-read the batch under a new set of merge decisions. */
  const chooseNearMiss = (fold, choice) => {
    const choices = { ...nearMissChoices, [fold]: choice };
    setNearMissChoices(choices);
    applySchema(files, compareSchemas(files, canonicalOf(choices)), givenRef.current);
  };

  /**
   * Read a picked file list. Media files are kept aside; .eaf files are parsed
   * and compared. Throws with a message fit to show the user.
   *
   * `given` is the mapping a resumed import was answered with the first time
   * (`{roles, fieldNames, nearMissChoices, recordMediaName}`), which the batch
   * takes instead of its own suggestions.
   */
  const readFiles = async (fileList, given = null) => {
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
    adoptBatch(parsed, given);
    return true;
  };

  /**
   * Take the mapping a resumed import was answered with over a batch already
   * read. The record is fetched while the person is choosing the files, so
   * the two do not always land in that order; the batch keeps its own copy
   * of the answers (givenRef) and this is what hands them over late.
   */
  const applyRecorded = (given) => {
    if (!files || !given) return;
    adoptBatch(files, given);
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
    // The merge decisions stand for every pair the batch still has: dropping
    // them would un-fold the tiers the mapping is filed under, and on a
    // resume, where they cannot be answered again, leave the import with
    // nothing to decide them with.
    const folds = new Set(result.nearMisses.map((g) => g.fold));
    const choices = Object.fromEntries(
      Object.entries(nearMissChoices).filter(([fold]) => folds.has(fold)),
    );
    const canonical = canonicalOf(choices);
    setFiles(kept);
    setNearMissGroups(result.nearMisses);
    setNearMissChoices(choices);
    applySchema(kept, canonical ? compareSchemas(kept, canonical) : result, givenRef.current);
  };

  const reset = () => {
    setFiles(null);
    setComparison(null);
    setMediaFiles([]);
    setNearMissGroups([]);
    setNearMissChoices({});
    givenRef.current = null;
  };

  return {
    // Everything the review step was answered with, in the shape `readFiles`
    // takes back: what an importer records so a resume repeats this mapping.
    choices: { roles, fieldNames, nearMissChoices, recordMediaName },
    recordMediaName,
    setRecordMediaName,
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
    applyRecorded,
    removeEaf,
    removeMedia: (file) => setMediaFiles((prev) => prev.filter((f) => f !== file)),
    chooseNearMiss,
    setRole: (key, role) => setRoles((r) => ({ ...r, [key]: role })),
    setName: (key, name) => setFieldNames((n) => ({ ...n, [key]: name })),
    reset,
  };
}
