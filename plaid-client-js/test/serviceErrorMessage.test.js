// What a failed service request tells the person who asked.
//
// The raw error a service throws names the endpoint the client called
// (`... at http://plaid.internal:8085/api/v1/spans`) and, when it carries no
// message of its own, the class that raised it. Neither is the requester's
// business. Every path that reports a failure goes through one scrub: `serve`'s
// own fallback and the `helper.error` a service calls itself. The Python twin
// is `requester_message` / `service_error_message`.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  requesterMessage,
  serve,
  UNKNOWN_FAILURE,
} from "../src/services.js";

/** Stand `serve` up against a fake channel and play one request down it. */
function served(handler) {
  const events = [];
  let onEvent = null;
  const client = {
    messages: {
      listen: (_projectId, cb) => {
        onEvent = cb;
        return { readyState: 1, close() {} };
      },
    },
    _request: async (_method, _path, opts) => {
      events.push(opts.body);
    },
  };
  const registration = serve(
    client,
    "p1",
    { serviceId: "svc1", serviceName: "Punkt tokenizer" },
    handler,
  );
  const deliver = (data) =>
    onEvent("service_request", { requestId: "r1", data: data || {} });
  return { registration, deliver, events };
}

async function reportedError(handler) {
  const { registration, deliver, events } = served(handler);
  const realError = console.error;
  console.error = () => {};
  try {
    deliver();
    // The helper reports asynchronously.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  } finally {
    console.error = realError;
    registration.stop();
  }
  const errors = events
    .filter((e) => e.status === "error")
    .map((e) => e.data.error);
  assert.equal(
    errors.length,
    1,
    `expected one error event, got ${JSON.stringify(events)}`,
  );
  return errors[0];
}

test("the scrub takes an internal URL out of an API failure", () => {
  const err = new Error(
    "HTTP 400 Span value is required at http://plaid.internal:8085/api/v1/spans",
  );
  err.status = 400;
  err.url = "http://plaid.internal:8085/api/v1/spans";
  assert.equal(requesterMessage(err), "HTTP 400 Span value is required");

});

const networkError = (method, path, cause) => {
  const url = `http://plaid.internal:8085${path}`;
  const error = new Error(`Network error: ${cause?.message} at ${url}`);
  error.status = 0;
  error.url = url;
  error.method = method;
  error.originalError = cause;
  return error;
};

test("a write whose answer was lost may have been saved", () => {
  const reset = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("other side closed"), {
      code: "UND_ERR_SOCKET",
    }),
  });
  const said =
    "The Plaid server did not answer. This change may or may not have been saved.";
  assert.equal(requesterMessage(networkError("POST", "/api/v1/batch", reset)), said);
  const timedOut = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  assert.equal(
    requesterMessage(networkError("PUT", "/api/v1/spans/s1", timedOut)),
    said,
  );
});

test("a connection that never opened could not be reached", () => {
  const refused = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    }),
  });
  assert.equal(
    requesterMessage(networkError("POST", "/api/v1/batch", refused)),
    "The Plaid server could not be reached.",
  );
});

test("a read that got no answer saved nothing either way", () => {
  const timedOut = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  assert.equal(
    requesterMessage(networkError("GET", "/api/v1/documents/d1", timedOut)),
    "The Plaid server did not answer.",
  );
  assert.equal(
    requesterMessage(networkError("POST", "/api/v1/query", timedOut)),
    "The Plaid server did not answer.",
  );
});

test("the lock's own wording survives the scrub", () => {
  // documents.locked() already authors a 423 for the person who asked; it
  // carries no URL, so nothing may rewrite it.
  const said =
    "This document is being edited by a@b.com. Try again once they're done.";
  const err = new Error(said);
  err.status = 423;
  err.url = "http://x:8085/api/v1/documents/d1/lock";
  assert.equal(requesterMessage(err), said);
});

test("a transport error loses its URL and a key loses itself", () => {
  assert.equal(
    requesterMessage(
      new Error(
        "404 Client Error: Not Found for url: http://plaid.internal:8085/api/v1/media?v=3",
      ),
    ),
    "404 Client Error: Not Found",
  );
  assert.equal(
    requesterMessage(
      new Error("Incorrect API key provided: sk-abcdefghij. Check your key."),
      ["sk-abcdefghij"],
    ),
    "Incorrect API key provided: [redacted]. Check your key.",
  );
  // A short or empty "secret" must not turn every message into redactions.
  assert.equal(requesterMessage(new Error("plain"), ["", "ab"]), "plain");
});

test("an error with nothing to say is not named by its class", () => {
  assert.equal(requesterMessage(new TypeError("")), UNKNOWN_FAILURE);
  assert.equal(requesterMessage(undefined), UNKNOWN_FAILURE);
});

test("serve's fallback does not hand the requester an internal URL", async () => {
  const message = await reportedError(() => {
    const err = new Error(
      "HTTP 400 Span value is required at http://plaid.internal:8085/api/v1/spans",
    );
    err.status = 400;
    err.url = "http://plaid.internal:8085/api/v1/spans";
    throw err;
  });
  assert.equal(message, "Punkt tokenizer: HTTP 400 Span value is required");
});

test("serve's fallback catches a rejected async handler too", async () => {
  const message = await reportedError(async () => {
    throw new Error("Network error: fetch failed at http://plaid.internal:8085");
  });
  assert.equal(message, "Punkt tokenizer: Network error: fetch failed");
});

test("a service reporting its own error is scrubbed too", async () => {
  // The guard is on the helper, not only on serve's fallback: a service that
  // catches its own error and reports it reaches the requester the same way.
  const message = await reportedError((_data, helper) => {
    helper.error(
      new Error(
        "404 Client Error: Not Found for url: http://plaid.internal:8085/api/v1/media?v=3",
      ),
    );
  });
  assert.equal(message, "404 Client Error: Not Found");
});
