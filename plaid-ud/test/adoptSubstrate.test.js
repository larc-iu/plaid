// H33-UD-3: "Set up for UD" plans from the project as it is when the button
// is pressed, never from the page's copy. A set-up another tab or maintainer
// ran since, or this page's own earlier click whose batch landed before a
// later step failed, made the layers already, and a plan from the old copy
// made a second set of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adoptSubstrate } from '../src/domain/udProjectSetup.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';

const INPUT = [
  '# text = el perro',
  '1\tel\tel\tDET\t_\t_\t2\tdet\t_\t_',
  '2\tperro\tperro\tNOUN\t_\t_\t0\troot\t_\t_',
].join('\n');

// A project set up for UD, and the same project without its enhanced layer
// (the one layer the Lezgi projects lacked).
const fullProject = () => ({ id: 'p1', textLayers: rawDocFromConllu(INPUT).textLayers });
const withoutEnhanced = () => {
  const project = fullProject();
  for (const tokenLayer of project.textLayers[0].tokenLayers) {
    for (const spanLayer of tokenLayer.spanLayers || []) {
      spanLayer.relationLayers = (spanLayer.relationLayers || []).filter(
        (r) => r.config?.ud?.enhancedDependency !== true,
      );
    }
  }
  return project;
};

// Every call any part of the client gets, by its path. `projects.get`
// answers the project as the server holds it.
const serverClient = (calls, stored) => {
  const at = (path) =>
    new Proxy(() => {}, {
      get: (_t, key) => (key === 'then' ? undefined : at([...path, String(key)])),
      apply: (_t, _this, args) => {
        const name = path.join('.');
        calls.push(name);
        if (name === 'projects.get') return Promise.resolve(stored());
        const fn = args.find((a) => typeof a === 'function');
        return fn ? fn(at(['batched'])) : Promise.resolve({});
      },
    });
  return at([]);
};

const creates = (calls) => calls.filter((c) => /\.create$/.test(c));

test('the fixture is what it says', () => {
  assert.ok(
    fullProject().textLayers[0].tokenLayers.some((t) =>
      (t.spanLayers || []).some((s) =>
        (s.relationLayers || []).some((r) => r.config?.ud?.enhancedDependency === true),
      ),
    ),
  );
});

test('a set-up from a stale page adds nothing the project has since gained', async () => {
  const calls = [];
  await adoptSubstrate(
    serverClient(calls, () => fullProject()),
    withoutEnhanced(),
  );
  assert.equal(calls[1], 'projects.get', 'reads the project before planning');
  assert.deepEqual(creates(calls), []);
});

test('a set-up adds what the project lacks as it is now', async () => {
  const calls = [];
  await adoptSubstrate(
    serverClient(calls, () => withoutEnhanced()),
    fullProject(),
  );
  assert.deepEqual(creates(calls), ['batched.relationLayers.create']);
});

// The project another app set up: sentences and words, none of UD's layers.
const substrateOnly = () => {
  const project = fullProject();
  const text = project.textLayers[0];
  text.tokenLayers = text.tokenLayers.filter((t) => t.config?.plaid?.role !== 'syntactic-word');
  return project;
};

test('a set-up declares the rules of every layer it makes in the batch that makes them', async () => {
  const calls = [];
  await adoptSubstrate(
    serverClient(calls, () => substrateOnly()),
    substrateOnly(),
  );
  const declared = calls.filter((c) => c.startsWith('batched.') && c.endsWith('.setConstraints'));
  // Syntactic words, Form, Lemma, UPOS, XPOS, and both relation layers: what
  // a failure after the batch would otherwise leave bare for good.
  assert.deepEqual(declared, [
    'batched.tokenLayers.setConstraints',
    'batched.spanLayers.setConstraints',
    'batched.spanLayers.setConstraints',
    'batched.spanLayers.setConstraints',
    'batched.spanLayers.setConstraints',
    'batched.relationLayers.setConstraints',
    'batched.relationLayers.setConstraints',
  ]);
});
