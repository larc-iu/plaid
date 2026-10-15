// Tagset changes the assistant planned, written with the approver's own
// session when they approve the plan.
//
// A delegated token, which the assistant writes with, may not change a
// project's or a lexicon's settings or declare a layer's rules (core,
// H9-ACL-1). So a plan of tagset changes, always a plan of its own, is written
// here first, the way the tagset settings write it (TagsetsSettings.jsx: the
// tagsets and every field's rules in one batch), and the approval sent after it
// only reads the settings back (plaid-agent igt/tagsets.py `verify_settings`).
// Sending it again after a lost answer is safe: settings that already read as
// planned are not written twice.
//
// Op shapes, as the record carries them (keys recased on the wire):
//   set_tagset     {owner: 'project' | vocab id, was, name, before, after}
//                  `after` is the tagset as it will read, null to delete it.
//                  `before` is what it read when planned (null: it was new).
//   assign_tagset  {owner, fieldKind: 'span' | 'metadata' | 'entry_field', key, before, after}
//                  `after` is the tagset name the field will use, null for none.

import { IGT_NAMESPACE } from './igtConfig.js';
import { normalizeTagset } from './tagsets.js';
import { igtFields, queueFieldDeclarations, tagsetRefusal } from './igtConstraints.js';
import { getIgtLayerInfo } from './layerInfo.js';
import { CORE_VOCAB_FIELDS } from './vocabFields.js';

const SETTINGS_KINDS = Object.freeze(['set_tagset', 'assign_tagset']);
const PROJECT = 'project';

/** Whether a plan is a plan of tagset changes, which this module writes. */
export const isTagsetPlan = (plan) => {
  const ops = plan?.ops || [];
  return ops.length > 0 && ops.every((op) => SETTINGS_KINDS.includes(op?.kind));
};

const igtOf = (config) => {
  const v = config?.[IGT_NAMESPACE];
  return v && typeof v === 'object' ? v : {};
};

const nameOf = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// Equal as JSON with every object's keys in order.
const canonical = (v) => {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canonical(v[k])]),
    );
  }
  return v;
};
const same = (a, b) =>
  JSON.stringify(canonical(a ?? null)) === JSON.stringify(canonical(b ?? null));

// A tagset as the plan compares it: value records by value and description
// only, since the record recased any other key a value carries.
const comparable = (t) =>
  t == null
    ? null
    : {
        delimiters: t.delimiters ?? '',
        mode: t.mode,
        values: (t.values || []).map((v) => ({
          value: v.value,
          ...(v.description != null ? { description: v.description } : {}),
        })),
      };

const stored = (raw, name) =>
  raw && Object.hasOwn(raw, name) ? comparable(normalizeTagset(raw[name])) : null;

// The tagset to store for `after`, its value records taken from the stored
// one where it lists the value, so keys the record recased are kept as stored.
const toStore = (after, old) => {
  // By value as normalizeTagset reads them: trimmed, the first of a duplicate.
  const byValue = new Map();
  for (const v of old?.values || []) {
    const value = typeof v?.value === 'string' ? v.value.trim() : '';
    if (value && !byValue.has(value)) byValue.set(value, v);
  }
  return {
    ...(old && typeof old === 'object' ? old : {}),
    delimiters: after.delimiters ?? '',
    mode: after.mode,
    values: (after.values || []).map((v) => {
      const kept = byValue.get(v.value);
      const rec = kept ? { ...kept, value: v.value } : { value: v.value };
      if (v.description != null) rec.description = v.description;
      else delete rec.description;
      return rec;
    }),
  };
};

const fieldKind = (op) => op.fieldKind ?? op.field_kind;

// The name a field references now.
const referenceOf = (op, { config, spanLayers, entryFields }) => {
  const kind = fieldKind(op);
  if (kind === 'span') {
    return nameOf(igtOf(spanLayers.find((sl) => sl.id === op.key)?.config).tagset);
  }
  if (kind === 'metadata') {
    const m = (igtOf(config).documentMetadata || []).find((x) => x?.name === op.key);
    return nameOf(m?.tagset);
  }
  return nameOf(entryFields?.[op.key]?.tagset);
};

// 'after' when the settings read as `op` leaves them, 'before' as it found
// them, else 'moved' (someone changed them since the plan was made).
const stateOf = (op, live) => {
  if (op.kind === 'assign_tagset') {
    const now = referenceOf(op, live);
    if (now === (op.after ?? null)) return 'after';
    return now === (op.before ?? null) ? 'before' : 'moved';
  }
  const raw = igtOf(live.config).tagsets;
  const named = stored(raw, op.name);
  const was = stored(raw, op.was);
  const renamed = op.was !== op.name;
  if (same(named, comparable(op.after)) && (!renamed || was == null)) return 'after';
  if (same(was, comparable(op.before)) && (!renamed || named == null)) return 'before';
  return 'moved';
};

const readOwner = async (client, projectId, owner) => {
  if (owner === PROJECT) {
    const project = await client.projects.get(projectId);
    return {
      project,
      config: project?.config || {},
      spanLayers: igtFields(getIgtLayerInfo(project)),
    };
  }
  const vocab = await client.vocabLayers.get(owner);
  const fields = igtOf(vocab?.config).fields;
  return {
    config: vocab?.config || {},
    spanLayers: [],
    entryFields: fields && typeof fields === 'object' ? fields : {},
  };
};

/**
 * Queue on batch `b` the writes `ops` (one owner's) make over `live`, each
 * expecting what was read.
 */
const queueOwner = (b, projectId, owner, ops, live) => {
  const igt = igtOf(live.config);
  const raw = igt.tagsets && typeof igt.tagsets === 'object' ? igt.tagsets : null;
  const next = { ...(raw || {}) };
  const renames = new Map();
  for (const op of ops) {
    if (op.kind !== 'set_tagset') continue;
    const old = raw?.[op.was];
    delete next[op.was];
    if (op.after != null) {
      next[op.name] = toStore(op.after, old);
      if (op.was !== op.name) renames.set(op.was, op.name);
    }
  }
  const assigns = new Map(
    ops
      .filter((op) => op.kind === 'assign_tagset')
      .map((op) => [`${fieldKind(op)}\u0000${op.key}`, op.after ?? null]),
  );
  const final = (kind, key, name) => {
    const k = `${kind}\u0000${key}`;
    return assigns.has(k) ? assigns.get(k) : (renames.get(name) ?? name);
  };
  const api = owner === PROJECT ? b.projects : b.vocabLayers;
  const ownerId = owner === PROJECT ? projectId : owner;
  if (!same(next, raw || {})) {
    api.setConfig(ownerId, IGT_NAMESPACE, 'tagsets', next, undefined, { expected: raw });
  }

  if (owner !== PROJECT) {
    const fields = { ...live.entryFields };
    for (const [k, name] of assigns) {
      const [kind, key] = k.split('\u0000');
      // A core field the config never named takes its default spec, as the
      // field editor writes it.
      if (kind === 'entry_field' && name && !Object.hasOwn(fields, key)) {
        const core = CORE_VOCAB_FIELDS.find((f) => f.name === key);
        fields[key] = { inline: !!core?.inline };
      }
    }
    for (const key of Object.keys(fields)) {
      const spec = fields[key] && typeof fields[key] === 'object' ? fields[key] : {};
      const old = nameOf(spec.tagset);
      const name = final('entry_field', key, old);
      if (name === old) continue;
      const { tagset: _dropped, ...rest } = spec;
      fields[key] = name ? { ...rest, tagset: name } : rest;
    }
    if (!same(fields, live.entryFields)) {
      b.vocabLayers.setConfig(ownerId, IGT_NAMESPACE, 'fields', fields, undefined, {
        expected: igt.fields ?? null,
      });
    }
    return;
  }

  const meta = igt.documentMetadata;
  if (Array.isArray(meta)) {
    const nextMeta = meta.map((m) => {
      if (!m || typeof m !== 'object' || !m.name) return m;
      const old = nameOf(m.tagset);
      const name = final('metadata', m.name, old);
      if (name === old) return m;
      const { tagset: _dropped, ...rest } = m;
      return name ? { ...rest, tagset: name } : rest;
    });
    if (!same(nextMeta, meta)) {
      b.projects.setConfig(ownerId, IGT_NAMESPACE, 'documentMetadata', nextMeta, undefined, {
        expected: meta,
      });
    }
  }

  // Each field as it will read, for the rules a closed list puts on it.
  const fields = live.spanLayers.map((sl) => {
    const old = nameOf(igtOf(sl.config).tagset);
    const name = final('span', sl.id, old);
    if (name !== old) {
      if (name) {
        b.spanLayers.setConfig(sl.id, IGT_NAMESPACE, 'tagset', name, undefined, {
          expected: igtOf(sl.config).tagset ?? null,
        });
      } else {
        b.spanLayers.deleteConfig(sl.id, IGT_NAMESPACE, 'tagset', undefined, {
          expected: igtOf(sl.config).tagset ?? null,
        });
      }
    }
    return {
      ...sl,
      config: { ...sl.config, [IGT_NAMESPACE]: { ...igtOf(sl.config), tagset: name } },
    };
  });
  const after = { ...live.config, [IGT_NAMESPACE]: { ...igt, tagsets: next } };
  queueFieldDeclarations(b, fields, after);
};

// A client of its own on the approver's session, so the write is an
// operation of its own: it neither joins one the shared client holds open
// nor is joined by one that opens on it meanwhile. A client that cannot be
// made again (a test double) is used as it is.
const apart = (client) => {
  const Own = client?.constructor;
  return typeof Own === 'function' && Own !== Object && typeof client.baseUrl === 'string'
    ? new Own(client.baseUrl, client.token, { onAuthError: client.onAuthError })
    : client;
};

/**
 * Write a plan of tagset changes with `client` (the approver's own), before
 * its approval is sent. Throws, writing nothing, when settings it changes
 * moved since the plan was made, or when core refuses the batch (a closed
 * list the stored values break: the error's message says which). Settings
 * that already read as planned are left as they are. `operation`
 * ({message, kind, ref}, plaid-ui `planOperation`) is the plan's own
 * operation, as the service opens one for every other plan it applies.
 */
export const writeTagsetPlan = async (client, projectId, plan, operation = null) => {
  const ops = (plan?.ops || []).filter((op) => SETTINGS_KINDS.includes(op?.kind));
  if (!ops.length) return false;
  const owners = [...new Set(ops.map((op) => op.owner))];
  const lives = new Map();
  for (const owner of owners) lives.set(owner, await readOwner(client, projectId, owner));
  const states = ops.map((op) => stateOf(op, lives.get(op.owner)));
  if (states.every((s) => s === 'after')) return false;
  if (states.some((s) => s === 'moved')) {
    throw new Error(
      'The tagset settings this plan changes were changed since it was made, so nothing was written. Ask the assistant to plan it again.',
    );
  }
  const own = apart(client);
  const write = () =>
    own.batched((b) => {
      for (const owner of owners) {
        queueOwner(
          b,
          projectId,
          owner,
          ops.filter((op) => op.owner === owner),
          lives.get(owner),
        );
      }
    });
  try {
    if (operation) {
      await own.withOperation(operation.message, write, {
        kind: operation.kind,
        ref: operation.ref,
      });
    } else {
      await write();
    }
  } catch (error) {
    const words = tagsetRefusal(error);
    if (words) throw new Error(`${words} Nothing was written.`, { cause: error });
    throw error;
  }
  return true;
};
