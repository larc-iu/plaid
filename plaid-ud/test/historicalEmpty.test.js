// HUNT-udumr 4: a past state from before the UD set-up has tokens, only no UD
// words layer, and the Annotate tab said it had no tokens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historicalEmptyNotice } from '../src/domain/sentenceRows.js';

test('a past state with no UD words layer says it is from before the set-up', () => {
  assert.equal(
    historicalEmptyNotice({ textLayer: {}, wordTokenLayer: { tokens: [{ id: 'w' }] } }),
    'This state is from before the project was set up for UD.',
  );
  assert.equal(
    historicalEmptyNotice({ morphemeTokenLayer: { tokens: [] } }),
    'This state has no tokens.',
  );
});
