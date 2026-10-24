"""lib/gate.py against a fake upstream on localhost. No key, no network.

    $PLAID_AGENT_PYTHON -m pytest -q test_gate.py

Each test uses its own slot directory, so a live bench run is not slowed and
does not slow the tests.
"""
import json
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / 'lib'))
import gate as G  # noqa: E402

KEY = 'sk-test-secret-key'
OK = {'choices': [{'message': {'role': 'assistant', 'content': 'hi'}}],
      'usage': {'prompt_tokens': 3, 'completion_tokens': 1}}


class Fake:
    """An upstream that answers each request with the next entry of `script`
    (the last one repeats): an int status, ('sleep', s) to hang, 'stream', or
    ('drip', [d0, d1, ...]) to stream one chunk after each delay, with 'hang'
    third to leave the stream open after the last chunk."""

    def __init__(self, script):
        self.script = list(script)
        self.seen = []  # (time, authorization header)
        fake = self

        class H(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *a):
                pass

            def do_POST(self):
                self.rfile.read(int(self.headers.get('content-length') or 0))
                fake.seen.append((time.time(), self.headers.get('authorization')))
                step = fake.script[min(len(fake.seen) - 1, len(fake.script) - 1)]
                if isinstance(step, tuple) and step[0] == 'drip':
                    # a streamed answer: sleep each delay, then send one chunk
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/event-stream')
                    self.send_header('Transfer-Encoding', 'chunked')
                    self.end_headers()
                    self.wfile.flush()
                    for i, d in enumerate(step[1]):
                        time.sleep(d)
                        c = f'data: {{"choices":[{{"delta":{{"content":"{i}"}}}}]}}\n\n'.encode()
                        self.wfile.write(f'{len(c):x}\r\n'.encode() + c + b'\r\n')
                        self.wfile.flush()
                    if len(step) > 2 and step[2] == 'hang':
                        time.sleep(5)  # never ends the stream: the gate's read times out
                        return
                    self.wfile.write(b'0\r\n\r\n')
                    self.wfile.flush()
                    return
                if isinstance(step, tuple) and step[0] == 'sleep':
                    time.sleep(step[1])
                    step = 200
                if step == 'stream':
                    body = (b'data: {"choices":[{"delta":{"content":"h"}}]}\n\n'
                            b'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n'
                            b'data: [DONE]\n\n')
                    ctype = 'text/event-stream'
                    step = 200
                elif step == 200:
                    body, ctype = json.dumps(OK).encode(), 'application/json'
                else:
                    body = json.dumps({'error': {'message': f'status {step}', 'code': str(step)}}).encode()
                    ctype = 'application/json'
                self.send_response(step)
                self.send_header('Content-Type', ctype)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), H)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def url(self):
        return f'http://127.0.0.1:{self.server.server_address[1]}/v1'

    def stop(self):
        self.server.shutdown()


@pytest.fixture
def env(tmp_path):
    made = []

    def make(script, **kw):
        fake = Fake(script)
        log = tmp_path / 'gate.jsonl'
        kw.setdefault('backoff', (0.05,))
        kw.setdefault('retry_budget_s', 2.0)
        kw.setdefault('rpm', 1000)  # tests of the per-minute cap set their own
        g = G.Gate(KEY, upstream=kw.pop('upstream', fake.url), logs={'t': log},
                   slot_dir=tmp_path / 'slots', **kw).start()
        made.append((fake, g))
        return fake, g, log
    yield make
    for fake, g in made:
        g.stop()
        fake.stop()


def ask(g, stream=False, timeout=30):
    body = json.dumps({'model': 'm', 'stream': stream, 'messages': [{'role': 'user', 'content': 'x'}]}).encode()
    req = urllib.request.Request(g.base('t') + '/chat/completions', data=body,
                                 headers={'Content-Type': 'application/json', 'Authorization': 'Bearer dummy'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def records(log, n=1):
    """The gate's log, once it has n records (the gate logs a request just
    after the client has its answer)."""
    deadline = time.time() + 10
    while True:
        rows = [json.loads(x) for x in log.read_text().splitlines() if x.strip()] if log.exists() else []
        if len(rows) >= n or time.time() > deadline:
            return rows


def test_passes_through_and_holds_the_key(env):
    fake, g, log = env([200])
    status, body = ask(g)
    assert status == 200 and json.loads(body)['choices'][0]['message']['content'] == 'hi'
    assert fake.seen[0][1] == f'Bearer {KEY}'  # the gate's key upstream, not the client's
    rec, = records(log)
    assert rec['status'] == 200 and rec['attempts'] == 1 and 'infra' not in rec
    assert rec['usage'] == OK['usage']
    assert KEY not in log.read_text()


def test_streams_and_reads_usage(env):
    fake, g, log = env(['stream'])
    status, body = ask(g, stream=True)
    assert status == 200 and b'[DONE]' in body
    assert records(log)[0]['usage'] == {'prompt_tokens': 5, 'completion_tokens': 2}


def test_logs_the_wait_for_the_first_chunk_and_the_longest_silence(env):
    # a call of about 1.6 s that streams all along: first chunk at 0.3 s,
    # longest silence 0.7 s, against a total that would have tripped a
    # limit on the whole call
    fake, g, log = env([('drip', [0.3, 0.2, 0.7, 0.1, 0.3])])
    status, body = ask(g, stream=True)
    assert status == 200 and body.count(b'data:') == 5
    rec, = records(log)
    assert 1.5 <= rec['upstream_s'] < 2.5
    assert 0.25 <= rec['first_chunk_s'] < 0.5
    assert 0.65 <= rec['max_gap_s'] < 0.95
    assert 'infra' not in rec


def test_a_slow_first_chunk_is_logged_apart_from_the_gaps(env):
    fake, g, log = env([('drip', [0.9, 0.1, 0.1])])
    ask(g, stream=True)
    rec, = records(log)
    assert 0.85 <= rec['first_chunk_s'] < 1.2 and rec['max_gap_s'] < 0.4


def test_a_stream_that_goes_silent_and_breaks_counts_the_silence(env):
    # two chunks, then nothing until the gate's own read timeout
    fake, g, log = env([('drip', [0.1, 0.1], 'hang')], upstream_timeout_s=0.8)
    with pytest.raises(Exception):  # the gate cuts the stream it could not finish
        ask(g, stream=True)
    rec, = records(log)
    assert rec['infra'] == 'stream_broken'
    assert rec['first_chunk_s'] < 0.3 and 0.7 <= rec['max_gap_s'] < 1.5


def test_a_call_with_no_chunk_is_silent_the_whole_time(env):
    fake, g, log = env([('drip', [], 'hang')], upstream_timeout_s=0.6)
    with pytest.raises(Exception):  # the gate cuts the stream it could not finish
        ask(g, stream=True)
    rec, = records(log)
    assert rec['first_chunk_s'] is None and rec['max_gap_s'] >= 0.55


def test_an_unstreamed_answer_is_one_chunk(env):
    fake, g, log = env([('sleep', 0.5)])
    ask(g)
    rec, = records(log)
    assert rec['first_chunk_s'] >= 0.45 and rec['max_gap_s'] < 0.2


def test_429_is_retried_inside_the_gate(env):
    fake, g, log = env([429, 429, 503, 200])
    status, body = ask(g)
    assert status == 200 and len(fake.seen) == 4
    rec, = records(log)
    assert rec['status'] == 200 and rec['attempts'] == 4 and 'infra' not in rec
    assert [a['status'] for a in rec['retried']] == [429, 429, 503]
    assert rec['backoff_s'] >= 0.15


def test_429_reaches_the_client_only_after_the_budget(env):
    fake, g, log = env([429], retry_budget_s=0.5)
    t0 = time.time()
    status, body = ask(g)
    assert status == 429 and b'status 429' in body
    assert 0.4 <= time.time() - t0 < 5
    assert len(fake.seen) >= 5
    rec, = records(log)
    assert rec['status'] == 429 and rec['infra'] == 'rate_limited' and rec['attempts'] == len(fake.seen)


def test_a_client_error_is_not_retried(env):
    fake, g, log = env([400])
    status, _ = ask(g)
    assert status == 400 and len(fake.seen) == 1
    rec, = records(log)
    assert rec['attempts'] == 1 and 'infra' not in rec


def test_an_upstream_timeout_is_infra(env):
    fake, g, log = env([('sleep', 1.0)], upstream_timeout_s=0.2, retry_budget_s=0.3)
    status, _ = ask(g)
    assert status == 502
    rec = records(log)[0]
    assert rec['infra'] == 'timeout' and rec['attempts'] >= 2


def test_an_unreachable_upstream_is_infra(env):
    fake, g, log = env([200], upstream='http://127.0.0.1:9/v1', retry_budget_s=0.2)
    status, _ = ask(g)
    assert status == 502
    assert records(log)[0]['infra'] == 'unreachable'


def test_the_per_minute_cap_holds_in_one_gate(env):
    fake, g, log = env([200], rpm=3)
    g.rate.window = 1.0
    t0 = time.time()
    for _ in range(7):
        assert ask(g)[0] == 200
    assert time.time() - t0 >= 2.0  # 7 sends at 3 a window need 3 windows
    ts = [t for t, _ in fake.seen]
    assert max(sum(1 for u in ts if t <= u < t + 0.95) for t in ts) <= 3
    assert sum(r['rate_wait_s'] for r in records(log, 7)) > 1.5


def test_retries_count_against_the_cap(env):
    fake, g, log = env([429, 429, 429, 200], rpm=2)
    g.rate.window = 1.0
    t0 = time.time()
    assert ask(g)[0] == 200
    assert time.time() - t0 >= 1.0  # 4 attempts at 2 a window


RATE_CHILD = '''
import sys, time, json
sys.path.insert(0, sys.argv[1])
import gate
cap = gate.RateCap(per_min=4, slot_dir=sys.argv[2], window=1.0)
out = []
for _ in range(6):
    cap.take()
    out.append(time.time())
print(json.dumps(out))
'''


def test_the_per_minute_cap_holds_across_processes(tmp_path):
    procs = [subprocess.Popen([sys.executable, '-c', RATE_CHILD, str(HERE / 'lib'), str(tmp_path)],
                              stdout=subprocess.PIPE, text=True) for _ in range(3)]
    ts = sorted(t for p in procs for t in json.loads(p.communicate(timeout=60)[0]))
    assert len(ts) == 18
    assert max(sum(1 for u in ts if t <= u < t + 0.95) for t in ts) <= 4
    assert ts[-1] - ts[0] >= 3.5  # 18 sends at 4 a second take more than 4 windows


def test_infra_of():
    failed = {'pass': False, 'turn_ends': ['failed', 'answered'], 'endpoint_errors': ['rate_limited']}
    assert G.infra_of(failed) == 'rate_limited'
    assert G.infra_of(dict(failed, **{'pass': True})) is None
    # every turn ended normally: the failure is the assistant's
    assert G.infra_of(dict(failed, turn_ends=['answered'])) is None
    assert G.infra_of(dict(failed, endpoint_errors=[])) is None
    assert G.infra_of({'pass': False, 'turn_ends': [], 'harness_error': 'TimeoutError',
                       'endpoint_errors': ['timeout']}) == 'timeout'


def test_infra_of_reads_an_old_gate_log(tmp_path):
    log = tmp_path / 'gate.jsonl'
    log.write_text(json.dumps({'status': 200}) + '\n' + json.dumps({'status': 429, 'error': 'capacity'}) + '\n')
    assert G.infra_of({'pass': False, 'turn_ends': ['failed']}, log) == 'rate_limited'


def test_defaults():
    assert G.SLOTS == 1
    assert G.RPM == 8 or 'BENCH_RPM' in __import__('os').environ


# --- the headless panel is a request-only client ---------------------------------

def test_the_panel_writes_no_user_data():
    """The assistant service is the only writer of a conversation record:
    the panel sends requests and reads."""
    import panel as P
    source = (HERE / 'lib' / 'panel.py').read_text()
    for word in ('ConversationStore', 'build_meta', 'user_item', '.put(', '.delete(', '.save('):
        assert word not in source, word

    class UserData:
        def __init__(self):
            self.writes = []

        def get(self, user_id, key):
            raise KeyError(key)

        def put(self, *a, **k):
            self.writes.append(('put', a))

        def delete(self, *a, **k):
            self.writes.append(('delete', a))

    class Messages:
        def __init__(self):
            self.asked = []

        def request_service(self, project_id, service_id, data, timeout, on_progress, **k):
            self.asked.append(dict(data))
            on_progress({'percent': 2, 'message': 'Thinking…', 'recorded': True})
            return {'kind': 'turn', 'message': 'ok'}

    class Client:
        user_data = UserData()
        messages = Messages()

    client = Client()
    panel = P.Panel(client, 'u@x', 'p1', 'igt', {'service_id': 'igt:assist:m'})
    out = panel.turn('hello', where={'kind': 'document', 'id': 'd1', 'name': 'Text 1'})
    panel.turn('again')
    panel.approve('plan-1', as_human=True)
    assert out['first_progress_s'] is not None
    assert client.user_data.writes == []
    sent = client.messages.asked
    assert [d['op'] for d in sent] == ['send', 'send', 'approve']
    assert sent[0]['create'] is True and sent[1]['create'] is False
    assert len({d['tab'] for d in sent}) == 1 and sent[0]['where']['name'] == 'Text 1'
    assert sent[2]['plan_id'] == 'plan-1' and sent[2]['as_human'] is True


def _tagset_panel(answers):
    """A panel whose record holds one undecided tagset plan, and whose
    service answers each request with the next of ``answers``."""
    sys.path.insert(0, str(HERE / 'lib'))
    import panel as P
    plan = {'id': 'plan-t', 'summary': 'add NOM', 'ops': [
        {'kind': 'set_tagset', 'owner': 'project', 'was': 'Leipzig', 'name': 'Leipzig'}]}

    class UserData:
        def get(self, user_id, key):
            if ':conv:' in key:
                return {'value': {'messages': [], 'display': [{'kind': 'assistant', 'plan': plan}]}}
            raise KeyError(key)

    class Messages:
        def __init__(self):
            self.asked = []

        def request_service(self, project_id, service_id, data, timeout, on_progress, **k):
            self.asked.append(dict(data))
            return answers.pop(0)

    class Client:
        user_data = UserData()
        messages = Messages()

    return P.Panel(Client(), 'u@x', 'p1', 'igt', {'service_id': 'igt:assist:m'}, code=HERE), plan


def test_a_tagset_plan_is_written_by_the_page_between_a_preflight_and_the_approval():
    """The page's protocol (plaid-ui jobs.js), picked by the
    registry's APP stage: preflight, igt's write, approve with wrote_first."""
    panel, plan = _tagset_panel([{'kind': 'ready'}, {'kind': 'applied'}])
    wrote = []
    panel._page_write = lambda p: wrote.append(p['id']) or True
    out = panel.approve('plan-t')
    asked = panel.client.messages.asked
    assert wrote == ['plan-t'] and out['result'] == {'kind': 'applied'}
    assert [(d['op'], d.get('preflight'), d.get('wrote_first')) for d in asked] == [
        ('approve', True, None), ('approve', None, True)]


def test_a_page_write_that_wrote_nothing_approves_without_wrote_first(monkeypatch, tmp_path):
    """igt's writeTagsetPlan answers false when every setting
    already reads as planned, and the page then approves with no wroteFirst,
    so the service settles it as in force. The bench reads the runner's
    `wrote` and does the same."""
    panel, _plan = _tagset_panel([{'kind': 'ready'}, {'kind': 'applied'}])
    panel.client.base_url, panel.client.token = 'http://core', 't'
    panel.code = tmp_path
    (tmp_path / 'plaid-agent' / 'tests').mkdir(parents=True)
    (tmp_path / 'plaid-agent' / 'tests' / 'tagset_page_write.mjs').write_text('')

    class Ran:
        returncode = 0
        stdout = json.dumps({'wrote': False, 'notInForce': []})
        stderr = ''
    import panel as P
    monkeypatch.setattr(P.subprocess, 'run', lambda *a, **k: Ran())
    monkeypatch.setenv('PLAID_NODE', sys.executable)
    assert panel._page_write(_plan) is False
    panel.approve('plan-t')
    asked = panel.client.messages.asked
    assert [(d['op'], d.get('preflight'), d.get('wrote_first')) for d in asked] == [
        ('approve', True, None), ('approve', None, None)]


def test_a_failed_page_write_takes_the_mark_off_and_sends_no_approval():
    panel, _plan = _tagset_panel([{'kind': 'ready'}, {'kind': 'done'}])

    def fail(p):
        raise RuntimeError('core said no')
    panel._page_write = fail
    out = panel.approve('plan-t')
    assert out['error'] == 'app write: RuntimeError: core said no'
    assert [d['op'] for d in panel.client.messages.asked] == ['approve', 'unmark']


def test_a_preflight_that_is_not_ready_writes_nothing():
    panel, _plan = _tagset_panel([{'kind': 'refused', 'why': 'decided'}])
    panel._page_write = lambda p: (_ for _ in ()).throw(AssertionError('wrote'))
    assert panel.approve('plan-t')['result']['kind'] == 'refused'
