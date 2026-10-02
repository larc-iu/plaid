import { describe, it, expect } from 'vitest';
import { buildProjectFile } from '../../export/nativeJson.js';
import { restoreOtherLayers } from './otherLayers.js';

// The native archive must bring a project back as it was. It carried no
// `plaid` settings at all, since that namespace holds whose work is reviewed,
// and so lost the tartan, the research opt-in and a shared word layer's
// splitOnSpace (H24-SETTINGS-1): after an export and import a typed space
// inside a word no longer split it. Only the review lists (people) and the
// layer roles (setup's) stay behind.

const role = (r, extra = {}) => ({ plaid: { role: r, ...extra } });
const layers = () => [
  {
    id: 'tx',
    name: 'Baseline',
    config: role('baseline'),
    tokenLayers: [
      { id: 'sent', name: 'Sentences', config: role('sentence'), spanLayers: [] },
      {
        id: 'word',
        name: 'Words',
        config: role('word', { splitOnSpace: true, preserveOnSplit: ['prov', 'ud'] }),
        spanLayers: [],
      },
      { id: 'morph', name: 'Morphemes', config: role('morpheme'), spanLayers: [] },
    ],
  },
];
const source = () => ({
  id: 'p1',
  name: 'Shared',
  config: {
    igt: { initialized: true },
    plaid: {
      tartan: false,
      research: { telemetry: true },
      review: { maintainer: ['someone@example.com'] },
    },
  },
  textLayers: layers(),
});

// The project an import writes into, as setup leaves it: the roles and igt's
// own preserveOnSplit, nothing else under `plaid`.
const fresh = () => {
  const textLayers = layers();
  textLayers[0].tokenLayers[1].config = role('word', { preserveOnSplit: ['prov'] });
  return { id: 'p2', config: { igt: { initialized: true } }, textLayers };
};

const recording = () => {
  const writes = [];
  const set = (kind) => async (id, ns, key, value) => writes.push([kind, id, ns, key, value]);
  return {
    writes,
    client: {
      projects: { setConfig: set('project') },
      textLayers: { setConfig: set('textLayer') },
      tokenLayers: { setConfig: set('tokenLayer'), create: async () => ({ id: 'new' }) },
      spanLayers: { setConfig: set('spanLayer'), create: async () => ({ id: 'ns' }) },
      relationLayers: { setConfig: set('relationLayer'), create: async () => ({ id: 'nr' }) },
    },
  };
};

const archive = () =>
  buildProjectFile({ project: source(), documents: [], vocabularies: [], exportedAt: 'x' });

describe("the native archive and the project's plaid settings", () => {
  it('carries them, but not the review lists or the layer roles', () => {
    const file = archive();
    expect(file.otherConfig).toEqual({ plaid: { tartan: false, research: { telemetry: true } } });
    expect(file.otherLayers.config).toEqual({
      word: { plaid: { splitOnSpace: true, preserveOnSplit: ['prov', 'ud'] } },
    });
  });

  it('writes them back on import, leaving what setup wrote', async () => {
    const { client, writes } = recording();
    await restoreOtherLayers({ client, projectId: 'p2', project: fresh(), manifest: archive() });
    expect(writes).toEqual([
      ['project', 'p2', 'plaid', 'tartan', false],
      ['project', 'p2', 'plaid', 'research', { telemetry: true }],
      ['tokenLayer', 'word', 'plaid', 'splitOnSpace', true],
      ['tokenLayer', 'word', 'plaid', 'preserveOnSplit', ['prov', 'ud']],
    ]);
  });

  it('round-trips: the imported project exports the same settings', async () => {
    const { client, writes } = recording();
    const target = fresh();
    await restoreOtherLayers({ client, projectId: 'p2', project: target, manifest: archive() });
    // Apply the writes to the target, as the server would.
    const byId = { p2: target, word: target.textLayers[0].tokenLayers[1] };
    for (const [, id, ns, key, value] of writes) {
      const at = byId[id];
      at.config = { ...at.config, [ns]: { ...at.config?.[ns], [key]: value } };
    }
    const again = buildProjectFile({
      project: target,
      documents: [],
      vocabularies: [],
      exportedAt: 'x',
    });
    expect(again.otherConfig).toEqual(archive().otherConfig);
    expect(again.otherLayers.config).toEqual(archive().otherLayers.config);
  });

  it('does not let an archive edited by hand write the review lists or a role', async () => {
    const file = archive();
    file.otherConfig.plaid.review = { maintainer: ['intruder@example.com'] };
    file.otherLayers.config.word.plaid.role = 'sentence';
    const { client, writes } = recording();
    await restoreOtherLayers({ client, projectId: 'p2', project: fresh(), manifest: file });
    expect(writes.map((w) => w[3])).not.toContain('review');
    expect(writes.map((w) => w[3])).not.toContain('role');
  });
});
