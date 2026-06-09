/**
 * Tests for the service self-description helpers (serviceSchema.js): task
 * filtering (declared + legacy-prefix fallback), schema/summary accessors,
 * default building, value coercion, and the cross-language param-key casing
 * round-trip. Uses Node's built-in test runner — run with `npm test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TASKS,
  servesTask,
  filterServicesByTask,
  getParamSchema,
  getServiceSummary,
  buildDefaultValues,
  coerceParamValues,
} from '../src/serviceSchema.js';
import { transformRequest, transformResponse } from '../src/transforms.js';

const tokService = {
  serviceId: 'tok:nltk-punkt-tokenizer',
  serviceName: 'NLTK Punkt',
  description: 'short',
  extras: {
    schemaVersion: 1,
    tasks: ['tokenize'],
    summary: '## NLTK Punkt\nSentence + word segmentation.',
    parameters: [
      { key: 'language', label: 'Language', type: 'enum', required: true, default: 'english',
        options: [{ value: 'english', label: 'English' }, { value: 'german', label: 'German' }] },
    ],
  },
};

test('servesTask prefers the declared tasks array', () => {
  assert.equal(servesTask(tokService, TASKS.TOKENIZE), true);
  assert.equal(servesTask(tokService, TASKS.PARSE), false);
});

test('servesTask falls back to legacy id prefixes when tasks absent', () => {
  const legacy = { serviceId: 'asr:whisper-asr', extras: {} };
  assert.equal(servesTask(legacy, TASKS.TRANSCRIBE), true);
  assert.equal(servesTask(legacy, TASKS.TOKENIZE), false);
  // 'parse' has no legacy prefix, so an un-declared service never matches it.
  assert.equal(servesTask({ serviceId: 'stanza-parser', extras: {} }, TASKS.PARSE), false);
});

test('filterServicesByTask selects matching services', () => {
  const services = [tokService, { serviceId: 'asr:whisper-asr', extras: { tasks: ['transcribe'] } }];
  assert.deepEqual(filterServicesByTask(services, TASKS.TOKENIZE).map((s) => s.serviceId),
    ['tok:nltk-punkt-tokenizer']);
});

test('getServiceSummary prefers extras.summary, then description', () => {
  assert.match(getServiceSummary(tokService), /NLTK Punkt/);
  assert.equal(getServiceSummary({ description: 'fallback' }), 'fallback');
  assert.equal(getServiceSummary({}), '');
});

test('buildDefaultValues honors declared defaults and type fallbacks', () => {
  const schema = [
    { key: 'language', type: 'enum', default: 'english', options: [{ value: 'english', label: 'E' }] },
    { key: 'modelSize', type: 'enum', options: [{ value: 'tiny', label: 'T' }, { value: 'base', label: 'B' }] },
    { key: 'beam', type: 'number', min: 1 },
    { key: 'lowercase', type: 'boolean' },
    { key: 'note', type: 'string' },
    { key: 'langs', type: 'multiselect', options: [{ value: 'en', label: 'en' }] },
  ];
  assert.deepEqual(buildDefaultValues(schema), {
    language: 'english', modelSize: 'tiny', beam: 1, lowercase: false, note: '', langs: [],
  });
});

test('coerceParamValues casts, clamps, and validates required', () => {
  const schema = getParamSchema(tokService).concat([
    { key: 'beam', label: 'Beam', type: 'number', min: 1, max: 10 },
    { key: 'lower', label: 'Lower', type: 'boolean' },
    { key: 'langs', label: 'Langs', type: 'multiselect', options: [{ value: 'en', label: 'en' }, { value: 'de', label: 'de' }] },
  ]);
  const { values, errors } = coerceParamValues(schema, {
    language: 'german', beam: '99', lower: 'true', langs: ['en', 'xx'], junk: 1,
  });
  assert.equal(values.language, 'german');
  assert.equal(values.beam, 10);          // clamped to max
  assert.equal(values.lower, true);       // string coerced
  assert.deepEqual(values.langs, ['en']); // invalid option dropped
  assert.ok(!('junk' in values));         // unknown key dropped
  assert.deepEqual(errors, {});           // language satisfied
});

test('coerceParamValues flags missing required and falls back invalid enum', () => {
  const schema = getParamSchema(tokService); // language enum, required, default english
  const { values, errors } = coerceParamValues(schema, { language: 'klingon' });
  assert.equal(values.language, 'english'); // invalid enum -> default
  assert.deepEqual(errors, {});             // default is non-empty, so required satisfied

  const reqStr = [{ key: 'name', label: 'Name', type: 'string', required: true }];
  const r2 = coerceParamValues(reqStr, {});
  assert.ok(r2.errors.name);
});

test('param-key string values survive the request-data recasing round-trip', () => {
  // A param `key` is a value, used verbatim as a request-data field name. A
  // snake_case key (a Python service's convention) is a fixed point of the JS
  // camel->kebab transform (no uppercase to recase), so it reaches the wire as
  // `model_size`; the Python client's kebab->snake transform is likewise a no-op
  // on it, so the service reads `model_size`. Here we only assert the JS half is
  // a no-op (the cross-language trace is verified in the manual / by review).
  const wire = transformRequest({ model_size: 'base', language: 'en' });
  assert.deepEqual(wire, { model_size: 'base', language: 'en' }); // snake untouched (no uppercase)
  assert.deepEqual(transformResponse(wire), { model_size: 'base', language: 'en' });

  // A JS service's camelCase key round-trips too (camel->kebab->camel).
  assert.deepEqual(transformResponse(transformRequest({ modelSize: 'base' })), { modelSize: 'base' });
});

test('coerce: blank/invalid number falls back to the declared default (JS/Py parity)', () => {
  const schema = [{ key: 'beam', label: 'Beam', type: 'number', default: 4, min: 1, max: 10 }];
  const v = (raw) => coerceParamValues(schema, raw).values.beam;
  assert.equal(v({ beam: '' }), 4);
  assert.equal(v({ beam: '   ' }), 4);
  assert.equal(v({ beam: null }), 4);
  assert.equal(v({ beam: 'abc' }), 4);
  assert.equal(v({ beam: '7' }), 7);     // valid value preserved
  assert.equal(v({ beam: '99' }), 10);   // clamped to max
});

test('enum: an out-of-range declared default never escapes', () => {
  const schema = [{ key: 'x', label: 'X', type: 'enum', default: 'klingon',
    options: [{ value: 'en', label: 'E' }, { value: 'de', label: 'D' }] }];
  assert.equal(buildDefaultValues(schema).x, 'en');                       // falls to first option
  assert.equal(coerceParamValues(schema, { x: 'klingon' }).values.x, 'en');
});

test('required: numeric 0 and boolean false satisfy; empty string / multiselect [] do not', () => {
  const schema = [
    { key: 'n', label: 'N', type: 'number', required: true, default: 0 },
    { key: 'b', label: 'B', type: 'boolean', required: true },
    { key: 'm', label: 'M', type: 'multiselect', required: true, options: [{ value: 'a', label: 'a' }] },
    { key: 't', label: 'T', type: 'string', required: true },
  ];
  const { errors } = coerceParamValues(schema, { n: 0, b: false, m: [], t: '' });
  assert.ok(!errors.n);  // 0 is not "empty"
  assert.ok(!errors.b);  // false is not "empty"
  assert.ok(errors.m);   // empty array is empty
  assert.ok(errors.t);   // empty string is empty
});
