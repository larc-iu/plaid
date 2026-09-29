import { describe, it, expect } from 'vitest';
import { sameConfig } from '@ui/domain/configCells.js';
import { updateExportPresets, readExportPresets } from './presets.js';

// The preset list is one config value. A page that wrote the whole list from
// its own copy dropped a preset another maintainer had added since (V6 H6-2).
// A change is made to the list as stored, and a write refused because the
// list changed is made again to the new list.

const preset = (id, name = id) => ({ id, name, format: 'plaintext', options: {} });

const makeServer = (presets) => {
  const server = { id: 'p1', config: { igt: { export: { presets } } } };
  const client = {
    sent: 0,
    projects: {
      get: async () => structuredClone(server),
      setConfig: async (_id, ns, key, value, _audit, options) => {
        client.sent += 1;
        if (!sameConfig(options.expected, server.config[ns][key])) {
          throw Object.assign(new Error('HTTP 409'), { status: 409 });
        }
        server.config[ns][key] = structuredClone(value);
      },
    },
  };
  return { server, client };
};

describe('updateExportPresets', () => {
  it('keeps a preset another maintainer added after the page read the list', async () => {
    const { server, client } = makeServer([preset('a')]);
    const page = structuredClone(server);
    server.config.igt.export.presets.push(preset('theirs'));

    const stored = await updateExportPresets(client, page, (list) => [...list, preset('mine')]);
    expect(readExportPresets(server).map((p) => p.id)).toEqual(['a', 'theirs', 'mine']);
    expect(stored.presets.map((p) => p.id)).toEqual(['a', 'theirs', 'mine']);
    expect(readExportPresets(stored.project)).toEqual(stored.presets);
    expect(client.sent).toBe(2);
  });

  it('writes once when nothing changed in between', async () => {
    const { server, client } = makeServer([preset('a')]);
    await updateExportPresets(client, structuredClone(server), (list) => list.slice(1));
    expect(readExportPresets(server)).toEqual([]);
    expect(client.sent).toBe(1);
  });

  it('passes on a refusal from the change itself', async () => {
    const { server, client } = makeServer([preset('a')]);
    const page = structuredClone(server);
    server.config.igt.export.presets = [preset('a', 'renamed')];
    const edit = (list) => {
      if (list[0].name !== 'a') throw Object.assign(new Error('changed'), { status: 409 });
      return [preset('a', 'mine')];
    };
    await expect(updateExportPresets(client, page, edit)).rejects.toThrow('changed');
    expect(readExportPresets(server)[0].name).toBe('renamed');
  });
});
