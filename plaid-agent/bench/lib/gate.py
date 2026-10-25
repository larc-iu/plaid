"""The model gate: a local OpenAI-compatible proxy in front of the model
endpoint that every bench assistant talks to instead of the endpoint itself.
The endpoint is $PLAID_BENCH_UPSTREAM (an OpenAI-compatible base URL ending
in /v1), and the key is the content of the file $PLAID_BENCH_KEY_FILE names.
Neither has a default.

- It holds the API key. The key is read from that file into this process's
  memory by `Gate.from_env`, sent upstream in the Authorization header,
  and never printed, logged or passed to a child process. The assistants it
  serves get a dummy key.
- It caps requests in flight ACROSS ALL BENCH PROCESSES at `SLOTS` (1), with
  lock files in .llm-slots/ of the data directory (lib/benchlib.py):: a request holds an exclusive flock on one
  slot file from before it is sent until its answer has been read to the end.
  The endpoint may serve other clients on the same key.
- It caps requests sent upstream per minute ACROSS ALL BENCH PROCESSES at
  `RPM` (8, or $BENCH_RPM), with a shared log of send times in
  .llm-slots/rpm.log under an flock on .llm-slots/rpm.lock, so the bench
  leaves the rest of a shared key's per-minute limit to its other clients.
  Every upstream attempt counts, retries too.
- A 429 from upstream, a 502, 503 or 504, or an upstream that cannot be
  reached or times out, is tried again inside the gate (holding its slot)
  after a wait (the answer's Retry-After, else 5, 10, 20, 40, 60, 60 ... s)
  for up to `RETRY_BUDGET_S` (600 s) from the first attempt. Only when that
  budget is spent does the failure reach the assistant.
- It logs every request (to the run named by the first path segment:
  /<tag>/v1/chat/completions) with the time spent waiting for a slot, for the
  per-minute cap and in backoff, the attempts, the last attempt's upstream
  time, the final status, and the token usage when the answer carries it. A
  record whose final status is not 200 carries `infra: <reason>`.

Streaming answers are passed through as they arrive. For the answer that
reached the assistant, the log has `first_chunk_s` (from the request sent to
the first chunk of the body, null when none came) and `max_gap_s` (the
longest silence after the first chunk, up to the stream's end or failure, or
the whole wait when no chunk came). Production's model timeout resets on
every chunk, so these, not `upstream_s`, say whether a call would have timed
out there.
"""
import fcntl
import http.client
import json
import os
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from benchlib import DATA

SLOTS = int(os.environ.get("BENCH_SLOTS") or 1)
RPM = int(os.environ.get("BENCH_RPM") or 8)
RPM_WINDOW_S = 60.0
RETRY_BUDGET_S = 600.0
RETRY_STATUS = (429, 502, 503, 504)
BACKOFF_S = (5, 10, 20, 40, 60)
UPSTREAM_TIMEOUT_S = 900
SLOT_DIR = DATA / '.llm-slots'


class Slot:
    def __init__(self, slots=SLOTS, slot_dir=None):
        slot_dir = Path(slot_dir or SLOT_DIR)
        slot_dir.mkdir(parents=True, exist_ok=True)
        self.paths = [slot_dir / f'slot{i}.lock' for i in range(slots)]
        self.fd = None

    def __enter__(self):
        while True:
            for p in self.paths:
                fd = os.open(p, os.O_RDWR | os.O_CREAT, 0o644)
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    self.fd = fd
                    return self
                except BlockingIOError:
                    os.close(fd)
            time.sleep(0.25)

    def __exit__(self, *exc):
        fcntl.flock(self.fd, fcntl.LOCK_UN)
        os.close(self.fd)


class RateCap:
    """At most `per_min` sends in any `window` seconds, across every process
    that shares `slot_dir`. `take()` blocks until a send is allowed, records
    it, and returns the seconds it waited. `last_slot` is the time it
    recorded for that send."""

    def __init__(self, per_min=RPM, slot_dir=None, window=RPM_WINDOW_S):
        d = Path(slot_dir or SLOT_DIR)
        d.mkdir(parents=True, exist_ok=True)
        self.per_min, self.window = per_min, window
        self.lock_path, self.log_path = d / 'rpm.lock', d / 'rpm.log'
        self.last_slot = None

    def take(self):
        t0 = time.time()
        while True:
            fd = os.open(self.lock_path, os.O_RDWR | os.O_CREAT, 0o644)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX)
                now = time.time()
                try:
                    sent = [float(x) for x in self.log_path.read_text().split() if x.strip()]
                except (FileNotFoundError, ValueError):
                    sent = []
                sent = sorted(t for t in sent if t > now - self.window)
                if len(sent) < self.per_min:
                    sent.append(now)
                    tmp = self.log_path.with_suffix('.tmp')
                    tmp.write_text(''.join(f'{t:.3f}\n' for t in sent))
                    os.replace(tmp, self.log_path)
                    self.last_slot = now
                    return time.time() - t0
                pause = sent[len(sent) - self.per_min] + self.window - now
            finally:
                fcntl.flock(fd, fcntl.LOCK_UN)
                os.close(fd)
            time.sleep(min(max(pause, 0.05), 5.0))


def _usage_of(body: bytes, streamed: bool):
    try:
        if not streamed:
            return json.loads(body).get('usage')
        usage = None
        for line in body.decode('utf-8', 'replace').splitlines():
            if line.startswith('data:') and '"usage"' in line:
                try:
                    u = json.loads(line[5:].strip()).get('usage')
                    usage = u or usage
                except ValueError:
                    pass
        return usage
    except Exception:  # noqa: BLE001
        return None


def _retry_after(r, attempt, backoff=BACKOFF_S):
    v = r.getheader('retry-after') if r is not None else None
    try:
        if v is not None:
            return min(max(float(v), 1.0), 120.0)
    except ValueError:
        pass
    return backoff[min(attempt, len(backoff) - 1)]


def infra_reason(status, error=None):
    """Why a final gate answer is the endpoint's fault, or None."""
    if status == 200:
        return 'stream_broken' if error else None
    if status == 429:
        return 'rate_limited'
    if status and status >= 500:
        return f'upstream_{status}'
    if not status:
        return 'timeout' if error and 'timeout' in error.lower() else 'unreachable'
    return None  # a 4xx other than 429 is the request's own fault


def infra_of(score, gate_log=None):
    """The endpoint's reason when a failed run failed on it: the run did not
    pass, a model call came back from the gate as a 429, a 5xx or a timeout
    after the gate's own retries, and a turn ended on an error (or the
    harness failed). None otherwise: a run whose turns all ended normally
    failed on the assistant's own work, whatever the endpoint did on the way."""
    if score.get('pass'):
        return None
    errs = score.get('endpoint_errors')
    if errs is None and gate_log is not None and Path(gate_log).exists():
        # a score.json from before the field: judge from the run's gate log
        recs = [json.loads(x) for x in Path(gate_log).read_text().splitlines() if x.strip()]
        errs = [x for x in (r.get('infra') or infra_reason(r.get('status'), r.get('error')) for r in recs) if x]
    errs = errs or []
    turn_failed = 'failed' in (score.get('turn_ends') or []) or score.get('request_errors') \
        or score.get('harness_error')
    if not errs or not turn_failed:
        return None
    return max(set(errs), key=errs.count)


class Gate:
    def __init__(self, key: str, upstream: str, logs=None, slot_dir=None, rpm=None,
                 retry_budget_s=None, backoff=BACKOFF_S, upstream_timeout_s=UPSTREAM_TIMEOUT_S, slots=SLOTS):
        self._key = key
        self.slots = slots
        self.up = urllib.parse.urlsplit(upstream)
        self.logs = logs if logs is not None else {}  # tag -> Path of a jsonl
        self.lock = threading.Lock()
        self.server = None
        self.slot_dir = slot_dir
        self.rate = RateCap(rpm or RPM, slot_dir)
        self.retry_budget_s = RETRY_BUDGET_S if retry_budget_s is None else retry_budget_s
        self.backoff = tuple(backoff)
        self.upstream_timeout_s = upstream_timeout_s

    @classmethod
    def from_env(cls, **kw):
        """The gate for $PLAID_BENCH_UPSTREAM with the key in $PLAID_BENCH_KEY_FILE."""
        upstream = os.environ.get('PLAID_BENCH_UPSTREAM')
        key_file = os.environ.get('PLAID_BENCH_KEY_FILE')
        if not upstream or not key_file:
            raise SystemExit('set PLAID_BENCH_UPSTREAM (the endpoint\'s base URL, ending in /v1) and '
                             'PLAID_BENCH_KEY_FILE (a file holding its API key)')
        with open(os.path.expanduser(key_file)) as f:
            return cls(f.read().strip(), upstream, **kw)

    def log(self, tag, rec):
        p = self.logs.get(tag)
        if not p:
            return
        with self.lock, open(p, 'a') as f:
            f.write(json.dumps(rec) + '\n')

    def _conn(self):
        cls = http.client.HTTPSConnection if self.up.scheme == 'https' else http.client.HTTPConnection
        port = self.up.port or (443 if self.up.scheme == 'https' else 80)
        return cls(self.up.hostname, port, timeout=self.upstream_timeout_s)

    def _clean(self, s):
        return s.replace(self._key, '<key>') if self._key else s

    def start(self, port=0):
        gate = self

        class H(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *a):
                pass

            def _send(self, status, headers, chunks):
                self.send_response(status)
                for k, v in headers:
                    if k.lower() in ('content-type', 'cache-control', 'retry-after'):
                        self.send_header(k, v)
                self.send_header('Transfer-Encoding', 'chunked')
                self.send_header('Connection', 'close')
                self.end_headers()
                got = b''
                for chunk in chunks:
                    if not chunk:
                        continue
                    got += chunk
                    self.wfile.write(f'{len(chunk):x}\r\n'.encode() + chunk + b'\r\n')
                    self.wfile.flush()
                self.wfile.write(b'0\r\n\r\n')
                self.wfile.flush()
                return got

            def _forward(self, method):
                parts = self.path.lstrip('/').split('/', 1)
                tag, rest = (parts[0], '/' + parts[1]) if len(parts) == 2 else ('', self.path)
                if rest.startswith('/v1'):
                    rest = rest[3:]
                n = int(self.headers.get('content-length') or 0)
                body = self.rfile.read(n) if n else None
                model, streamed = None, False
                if body:
                    try:
                        j = json.loads(body)
                        model, streamed = j.get('model'), bool(j.get('stream'))
                    except ValueError:
                        pass
                headers = {'Authorization': f'Bearer {gate._key}',
                           'Content-Type': self.headers.get('content-type', 'application/json'),
                           'Accept': self.headers.get('accept', '*/*')}
                t0 = time.time()
                with Slot(slots=gate.slots, slot_dir=gate.slot_dir):
                    waited = time.time() - t0
                    first = time.time()
                    attempts, rate_wait, backoff = [], 0.0, 0.0
                    status, got, err, t1, sent = 0, b'', None, time.time(), False
                    while True:
                        rate_wait += gate.rate.take()
                        t1 = time.time()
                        conn = gate._conn()
                        status, got, err, r = 0, b'', None, None
                        chunks = {'first': None, 'last': None, 'gap': 0.0}
                        try:
                            conn.request(method, gate.up.path.rstrip('/') + rest, body=body, headers=headers)
                            r = conn.getresponse()
                            status = r.status
                            if status in RETRY_STATUS:
                                got = r.read()
                            else:
                                def stream():
                                    while True:
                                        c = r.read1(65536) if hasattr(r, 'read1') else r.read(65536)
                                        now = time.time()
                                        if not c:
                                            return
                                        if chunks['first'] is None:
                                            chunks['first'] = now
                                        else:
                                            chunks['gap'] = max(chunks['gap'], now - chunks['last'])
                                        chunks['last'] = now
                                        yield c
                                sent = True
                                got = self._send(status, r.getheaders(), stream())
                        except Exception as e:  # noqa: BLE001
                            err = gate._clean(type(e).__name__ + ': ' + str(e))[:300]
                        finally:
                            conn.close()
                        attempts.append({'status': status, 'upstream_s': round(time.time() - t1, 3),
                                         **({'error': err} if err else {})})
                        if sent:
                            break
                        delay = _retry_after(r, len(attempts) - 1, gate.backoff)
                        if time.time() + delay - first > gate.retry_budget_s:
                            break
                        time.sleep(delay)
                        backoff += delay
                    if not sent:
                        try:
                            if status:
                                self._send(status, r.getheaders() if r is not None else [], [got])
                            else:
                                self.send_error(502, 'gate: upstream failed')
                        except Exception:  # noqa: BLE001
                            pass
                    rec = {'at': t0, 'tag': tag, 'path': rest, 'model': model, 'stream': streamed,
                           'status': status, 'wait_s': round(waited, 3), 'rate_wait_s': round(rate_wait, 3),
                           'backoff_s': round(backoff, 3), 'attempts': len(attempts),
                           'upstream_s': round(time.time() - t1, 3),
                           'bytes': len(got), 'usage': _usage_of(got, streamed) if status == 200 else None}
                    if sent:
                        # production's model timeout is a silence timeout that
                        # every chunk resets (plaid-client-py workflows/llm.py
                        # _streamed): log the wait for the first chunk and the
                        # longest silence after it, the end of the stream or
                        # its failure included, of the last attempt
                        end = time.time()
                        if chunks['first'] is None:
                            rec['first_chunk_s'] = None
                            rec['max_gap_s'] = round(end - t1, 3)
                        else:
                            rec['first_chunk_s'] = round(chunks['first'] - t1, 3)
                            rec['max_gap_s'] = round(max(chunks['gap'], end - chunks['last']), 3)
                    if len(attempts) > 1:
                        rec['retried'] = attempts[:-1]
                    if err:
                        rec['error'] = err
                    elif status != 200:
                        rec['error'] = gate._clean(got[:300].decode('utf-8', 'replace'))
                    why = infra_reason(status, err)
                    if why:
                        rec['infra'] = why
                    gate.log(tag, rec)
                self.close_connection = True

            def do_POST(self):
                self._forward('POST')

            def do_GET(self):
                self._forward('GET')

        self.server = ThreadingHTTPServer(('127.0.0.1', port), H)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    @property
    def port(self):
        return self.server.server_address[1]

    def base(self, tag):
        return f'http://127.0.0.1:{self.port}/{tag}/v1'

    def stop(self):
        if self.server:
            self.server.shutdown()
