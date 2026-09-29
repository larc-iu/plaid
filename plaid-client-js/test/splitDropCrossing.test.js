// tokens.split's dropCrossingRelations, as queued in a batch. The server's
// side is plaid-core's split-drops-crossing-relations-test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

test("split sends drop-crossing-relations only when given", () => {
  const b = new PlaidClient("http://localhost:0", "dummy-token").batch();
  b.tokens.split("T", 13);
  b.tokens.split("T", 13, undefined, { dropCrossingRelations: ["R1", "R2"] });
  assert.deepEqual(b.operations[0].body, { position: 13 });
  assert.deepEqual(b.operations[1].body, {
    position: 13,
    "drop-crossing-relations": ["R1", "R2"],
  });
  b.abort();
});
