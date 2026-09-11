// Pure-fn tests for the project-declared metadata fields (utils/udMetadata.js):
// what may be a field, and what an editor for a level should show.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  readMetadataFields,
  toMetadataConfig,
  metadataFieldError,
  metadataRows,
  SENT_ID,
} from '../src/utils/udMetadata.js';

test('readMetadataFields reads either level, and nothing from an unset project', () => {
  const config = {
    ud: {
      documentMetadata: [{ name: 'Source' }, { name: 'Genre' }],
      sentenceMetadata: [{ name: 'text_en' }],
    },
  };
  assert.deepEqual(readMetadataFields(config, 'document'), ['Source', 'Genre']);
  assert.deepEqual(readMetadataFields(config, 'sentence'), ['text_en']);
  assert.deepEqual(readMetadataFields({}, 'document'), []);
  assert.deepEqual(readMetadataFields(undefined, 'sentence'), []);
  // Order is the project's, not sorted.
  assert.deepEqual(readMetadataFields(config, 'document')[0], 'Source');
});

test('readMetadataFields ignores a malformed entry rather than rendering it', () => {
  const config = { ud: { documentMetadata: [{ name: 'Source' }, {}, { name: '  ' }, null, 42] } };
  assert.deepEqual(readMetadataFields(config, 'document'), ['Source']);
  assert.deepEqual(readMetadataFields({ ud: { documentMetadata: 'Source' } }, 'document'), []);
});

test('toMetadataConfig stores the object form, trimmed', () => {
  assert.deepEqual(toMetadataConfig([' Source ', 'Genre']), [
    { name: 'Source' },
    { name: 'Genre' },
  ]);
  assert.deepEqual(toMetadataConfig(null), []);
});

test('metadataFieldError refuses a dot, because the query engine reads one as a path', () => {
  assert.equal(
    metadataFieldError('speaker.name', 'document'),
    'A field name cannot contain a dot.',
  );
  assert.equal(metadataFieldError('speaker_name', 'document'), null);
});

test('metadataFieldError refuses the reserved names', () => {
  assert.match(metadataFieldError('prov', 'document'), /reserved for provenance/);
  assert.match(metadataFieldError('provSource', 'sentence'), /reserved for provenance/);
  assert.match(metadataFieldError(SENT_ID, 'sentence'), /already has sent_id/);
  assert.match(metadataFieldError('text', 'sentence'), /written from the document text/);
  // Those two are sentence-level only: a document may call a field either.
  assert.equal(metadataFieldError('text', 'document'), null);
  assert.equal(metadataFieldError(SENT_ID, 'document'), null);
});

test('metadataFieldError refuses an empty name and a duplicate', () => {
  assert.equal(metadataFieldError('   ', 'document'), 'A field needs a name.');
  assert.match(metadataFieldError('Genre', 'document', ['Source', 'Genre']), /already a field/);
  assert.match(metadataFieldError(' Genre ', 'document', ['Genre']), /already a field/);
  assert.equal(metadataFieldError('Licence', 'document', ['Source', 'Genre']), null);
});

test('metadataRows shows the declared fields plus whatever is already stored', () => {
  // "Genre" was declared and dropped, but the value is still there and still
  // exports. Hiding it would make it invisible and impossible to clear.
  const rows = metadataRows(['Source'], { Source: 'a', Genre: 'narrative' }, 'document');
  assert.deepEqual(rows, [
    { name: 'Source', declared: true },
    { name: 'Genre', declared: false },
  ]);
});

test('metadataRows leads a sentence with sent_id and never offers text', () => {
  const rows = metadataRows(
    ['text_en'],
    { sent_id: 's-1', text: 'the dog', note: 'x' },
    'sentence',
  );
  assert.deepEqual(rows, [
    { name: SENT_ID, declared: true },
    { name: 'text_en', declared: true },
    { name: 'note', declared: false },
  ]);
  // sent_id appears once even when the project also declares it.
  assert.equal(metadataRows([SENT_ID], {}, 'sentence').length, 1);
});

test('metadataRows never shows a provenance key as content', () => {
  const stored = { prov: 'inferred', provSource: 'service:p', provConfirmed: true, Source: 'a' };
  assert.deepEqual(metadataRows([], stored, 'document'), [{ name: 'Source', declared: false }]);
});
