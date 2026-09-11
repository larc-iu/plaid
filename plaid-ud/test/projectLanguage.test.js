// The project's language (General settings) and how it reaches a service's
// `language` argument. Uses Node's built-in test runner: run `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readProjectLanguage } from '../src/utils/udLayerUtils.js';
import { languageParamSeed } from '../src/utils/serviceDefaults.js';

const project = (language) => ({ config: { ud: { language } } });

const enumParam = (values) => [
  { key: 'language', type: 'enum', options: values.map((v) => ({ value: v, label: v })) },
  { key: 'overwrite', type: 'boolean' },
];

test('the language reads off the project, trimmed', () => {
  assert.equal(readProjectLanguage(project('de')), 'de');
  assert.equal(readProjectLanguage(project('  zh-Hans  ')), 'zh-Hans');
});

test('an unset, blank or non-string language reads as empty', () => {
  assert.equal(readProjectLanguage(null), '');
  assert.equal(readProjectLanguage({}), '');
  assert.equal(readProjectLanguage({ config: {} }), '');
  assert.equal(readProjectLanguage(project('')), '');
  assert.equal(readProjectLanguage(project(42)), '');
});

test('the tag seeds an enum argument that lists it', () => {
  assert.deepEqual(languageParamSeed(enumParam(['en', 'de', 'fr']), 'de'), { language: 'de' });
});

test('a tag the service has no option for seeds nothing', () => {
  assert.deepEqual(languageParamSeed(enumParam(['en', 'de']), 'lez'), {});
});

test('a free-text language argument takes any tag', () => {
  const schema = [{ key: 'language', type: 'string' }];
  assert.deepEqual(languageParamSeed(schema, 'lez'), { language: 'lez' });
});

test('a service with no language argument seeds nothing', () => {
  assert.deepEqual(languageParamSeed([{ key: 'overwrite', type: 'boolean' }], 'de'), {});
  assert.deepEqual(languageParamSeed([], 'de'), {});
  assert.deepEqual(languageParamSeed(null, 'de'), {});
});

test('no language stated seeds nothing', () => {
  assert.deepEqual(languageParamSeed(enumParam(['en']), ''), {});
  assert.deepEqual(languageParamSeed(enumParam(['en']), '   '), {});
  assert.deepEqual(languageParamSeed(enumParam(['en']), undefined), {});
});
