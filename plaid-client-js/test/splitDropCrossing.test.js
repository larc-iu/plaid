// tokens.split, as queued in a batch: the position and the id the client
// minted, and nothing about relations. A relation layer that must stay inside
// one token declares a same-ancestor constraint instead, and the server
// deletes what a split leaves crossing (plaid-core's
// split-drops-crossing-relations-test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

test("split sends the position, and the id only when given", () => {
  const b = new PlaidClient("http://localhost:0", "dummy-token").batch();
  b.tokens.split("T", 13);
  b.tokens.split("T", 13, undefined, { id: "N" });
  b.tokens.split("T", 13, undefined, { dropCrossingRelations: ["R1"] });
  assert.deepEqual(b.operations[0].body, { position: 13 });
  assert.deepEqual(b.operations[1].body, { id: "N", position: 13 });
  assert.deepEqual(b.operations[2].body, { position: 13 });
  b.abort();
});
