// A media upload can report its progress. fetch cannot say how many bytes have
// gone up, so a request with an `onProgress` callback travels by
// XMLHttpRequest instead, and everything after the wire (status handling,
// version headers, the parsed body) must come out the same.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaidClient } from '../src/index.js';
import { xhrSend } from '../src/http.js';

const encode = (obj) => new TextEncoder().encode(JSON.stringify(obj)).buffer;

class FakeXHR {
  static last = null;
  static onSend = null;
  constructor() {
    this.upload = {};
    this.headers = {};
    this.responseType = '';
    this.aborted = false;
    FakeXHR.last = this;
  }
  open(method, url) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name, value) {
    this.headers[name] = value;
  }
  send(body) {
    this.body = body;
    FakeXHR.onSend?.(this);
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  getAllResponseHeaders() {
    return this.rawHeaders || '';
  }
  respond({ status = 200, statusText = 'OK', json, rawHeaders = 'content-type: application/json\r\n' }) {
    this.status = status;
    this.statusText = statusText;
    this.rawHeaders = rawHeaders;
    this.response = encode(json);
    this.onload();
  }
}

const withFakeXhr = async (fn) => {
  const realXhr = globalThis.XMLHttpRequest;
  const realFetch = globalThis.fetch;
  globalThis.XMLHttpRequest = FakeXHR;
  FakeXHR.last = null;
  FakeXHR.onSend = null;
  try {
    return await fn();
  } finally {
    globalThis.XMLHttpRequest = realXhr;
    globalThis.fetch = realFetch;
  }
};

const makeClient = (options) => new PlaidClient('http://plaid.test', 'tok', options);

test('an upload with onProgress goes by XHR and reports the bytes as they go up', async () => {
  await withFakeXhr(async () => {
    FakeXHR.onSend = (xhr) => {
      xhr.upload.onprogress({ loaded: 5, total: 10, lengthComputable: true });
      xhr.upload.onprogress({ loaded: 10, total: 10, lengthComputable: true });
      xhr.respond({
        json: { ok: true },
        rawHeaders: 'content-type: application/json\r\nx-document-versions: {"doc-1":7}\r\n',
      });
    };
    const seen = [];
    const client = makeClient();
    const result = await client.documents.uploadMedia('doc-1', new Blob(['abc']), undefined, {
      onProgress: (p) => seen.push(p),
    });
    assert.deepEqual(seen, [
      { loaded: 5, total: 10 },
      { loaded: 10, total: 10 },
    ]);
    assert.deepEqual(result, { ok: true });
    const xhr = FakeXHR.last;
    assert.equal(xhr.method, 'PUT');
    assert.match(xhr.url, /\/api\/v1\/documents\/doc-1\/media/);
    assert.equal(xhr.headers.Authorization, 'Bearer tok');
    assert.equal(xhr.headers['Content-Type'], undefined); // multipart sets its own boundary
    assert.ok(xhr.body instanceof FormData);
    assert.equal(client.documentVersions['doc-1'], 7); // the version header still lands
  });
});

test('a failed upload rejects with the server status and message, like fetch', async () => {
  await withFakeXhr(async () => {
    FakeXHR.onSend = (xhr) =>
      xhr.respond({ status: 413, statusText: 'Payload Too Large', json: { error: 'File too large' } });
    await assert.rejects(
      makeClient().documents.uploadMedia('doc-1', new Blob(['abc']), undefined, {
        onProgress: () => {},
      }),
      (e) => e.status === 413 && /File too large/.test(e.message),
    );
  });
});

test('the timeout is a stall timeout: it fires when nothing moves, and aborts the request', async () => {
  await withFakeXhr(async () => {
    FakeXHR.onSend = () => {}; // never answers, never progresses
    await assert.rejects(
      makeClient({ timeout: 5 }).documents.uploadMedia('doc-1', new Blob(['abc']), undefined, {
        onProgress: () => {},
      }),
      /timed out/,
    );
    assert.equal(FakeXHR.last.aborted, true);
  });
});

// The abort a stall makes fires the request's own abort handler at once, so
// the stall has to be the first to reject, or its error is an AbortError.
test('a stall rejects with an error named TimeoutError', async () => {
  await withFakeXhr(async () => {
    FakeXHR.onSend = () => {};
    await assert.rejects(
      xhrSend('http://x/y', { method: 'PUT', headers: {}, body: 'abc' }, { timeout: 5 }),
      { name: 'TimeoutError' },
    );
    assert.equal(FakeXHR.last.aborted, true);
  });
});

test('without onProgress the upload still goes by fetch', async () => {
  await withFakeXhr(async () => {
    let fetched = 0;
    globalThis.fetch = async () => {
      fetched += 1;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await makeClient().documents.uploadMedia('doc-1', new Blob(['abc']));
    assert.equal(fetched, 1);
    assert.equal(FakeXHR.last, null);
  });
});

// A `signal` stops an upload: aborted, the request is cut off and the call
// rejects with the signal's reason (an AbortError), never as a network error
// a caller would send again.

test('an aborted signal cuts off an upload in flight and rejects with an AbortError', async () => {
  await withFakeXhr(async () => {
    const abort = new AbortController();
    FakeXHR.onSend = (xhr) => {
      xhr.upload.onprogress({ loaded: 5, total: 10, lengthComputable: true });
      abort.abort();
    };
    // Within a second, under the client's default timeout: the signal cuts the
    // request off, not the stall timer, which would do it after 30 s
    // (REV-FX-M1-A-1).
    let late = null;
    const tooLate = new Promise((_, reject) => {
      late = setTimeout(() => reject(new Error('not cut off within 1 s')), 1000);
    });
    try {
      await assert.rejects(
        Promise.race([
          makeClient().documents.uploadMedia('doc-1', new Blob(['abc']), undefined, {
            onProgress: () => {},
            signal: abort.signal,
          }),
          tooLate,
        ]),
        (e) => e.name === 'AbortError' && e.status === undefined,
      );
    } finally {
      clearTimeout(late);
    }
    assert.equal(FakeXHR.last.aborted, true);
  });
});

test('an upload whose signal is already aborted sends nothing', async () => {
  await withFakeXhr(async () => {
    let sent = 0;
    FakeXHR.onSend = () => {
      sent += 1;
    };
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      makeClient().documents.uploadMedia('doc-1', new Blob(['abc']), undefined, {
        onProgress: () => {},
        signal: abort.signal,
      }),
      (e) => e.name === 'AbortError',
    );
    assert.equal(sent, 0);
  });
});

test('an aborted signal is not retried as a busy server is', async () => {
  await withFakeXhr(async () => {
    const abort = new AbortController();
    let sent = 0;
    FakeXHR.onSend = (xhr) => {
      sent += 1;
      abort.abort();
      xhr.respond({ status: 503, statusText: 'Busy', json: { error: 'Database busy' } });
    };
    await assert.rejects(
      makeClient().documents.uploadMedia('doc-1', new Blob(['abc']), undefined, {
        onProgress: () => {},
        signal: abort.signal,
      }),
      (e) => e.name === 'AbortError',
    );
    assert.equal(sent, 1);
  });
});

test('without onProgress the signal stops the fetch', async () => {
  await withFakeXhr(async () => {
    const abort = new AbortController();
    globalThis.fetch = (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason));
        abort.abort();
      });
    await assert.rejects(
      makeClient().documents.uploadMedia('doc-1', new Blob(['abc']), undefined, {
        signal: abort.signal,
      }),
      (e) => e.name === 'AbortError' && e.status === undefined,
    );
  });
});
