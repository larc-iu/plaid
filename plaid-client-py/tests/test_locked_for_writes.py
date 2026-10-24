"""``locked_for_writes``: a service's writes carry the version the document had
once the lock was held (strict mode).

The bug this guards (conc-2026-09-29, V2 S1): a service batch the client gave
up on (a timeout, a lost answer) could still land after the run had released
the lock and someone had edited the text, and it stored word tokens that cut
the new words in half. Stamped with the version read under the lock, such a
batch is refused with a 409.
"""

import json
import os
import sys
import time
from urllib.parse import parse_qs, urlparse

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.client import PlaidClient  # noqa: E402
from plaid_client.service import locked_for_writes  # noqa: E402
from plaid_client.testing import FakeClient  # noqa: E402


class _Resp:
    ok = True
    status_code = 200
    reason = 'OK'

    def __init__(self, body, headers=None):
        self._body = body
        self.headers = {'content-type': 'application/json', **(headers or {})}
        self.text = json.dumps(body)
        self.content = self.text.encode()

    def json(self):
        return self._body


def _server(version):
    """A stub session that holds the lock and answers a document read with
    ``version``, a write by moving the version on. Returns the requests sent."""
    sent = []
    state = {'version': version}

    class _Session:
        def request(self, **kw):
            method, url = kw.get('method'), kw.get('url', '')
            sent.append({'method': method, 'url': url})
            path = urlparse(url).path
            if path.endswith('/lock'):
                return _Resp({'lock-id': 'L1', 'expires-at': int(time.time() * 1000) + 60_000}
                             if method == 'POST' else {})
            if method == 'GET':
                return _Resp({'document/id': 'd1', 'document/version': state['version']})
            state['version'] += 1
            return _Resp({}, {'X-Document-Versions': json.dumps({'d1': state['version']})})

        def post(self, url, **kw):
            return self.request(method='POST', url=url, **kw)

        def close(self):
            pass

    return _Session(), sent


def _version_of(url):
    values = parse_qs(urlparse(url).query).get('document-version')
    return values[0] if values else None


def test_every_write_in_the_block_carries_the_version_read_under_the_lock():
    client = PlaidClient('http://x', 'tok')
    client.session, sent = _server(7)
    client.document_versions['d1'] = 3   # an older read must not be what is claimed
    with locked_for_writes(client, 'd1'):
        client.spans.update('s1', 'NOUN')
        client.spans.update('s2', 'VERB')
    writes = [r for r in sent if r['method'] != 'GET' and not urlparse(r['url']).path.endswith('/lock')]
    assert [_version_of(r['url']) for r in writes] == ['7', '8']
    # The read came after the lock was taken, not before.
    kinds = [(r['method'], urlparse(r['url']).path.endswith('/lock')) for r in sent]
    assert kinds.index(('POST', True)) < kinds.index(('GET', False))
    # And strict mode ends with the block.
    assert client.strict_mode_document_id is None


def test_a_document_that_moved_since_the_request_was_made_is_refused_before_any_write():
    client = PlaidClient('http://x', 'tok')
    client.session, sent = _server(9)
    with pytest.raises(ValueError, match='changed after this run was asked for'):
        with locked_for_writes(client, 'd1', 8):
            client.spans.update('s1', 'NOUN')
    assert [r['method'] for r in sent if not urlparse(r['url']).path.endswith('/lock')] == ['GET']
    assert client.strict_mode_document_id is None


def test_strict_mode_the_caller_had_is_put_back():
    client = PlaidClient('http://x', 'tok')
    client.session, _ = _server(7)
    client.enter_strict_mode('other')
    with locked_for_writes(client, 'd1'):
        assert client.strict_mode_document_id == 'd1'
    assert client.strict_mode_document_id == 'other'


def test_the_fake_client_records_the_stamp_each_write_carried():
    client = FakeClient([{'id': 'd1', 'version': 4}])
    with locked_for_writes(client, 'd1', 4):
        with client.batched() as b:
            b.tokens.bulk_delete(['t1'])
        client.spans.update('s1', 'NOUN')
    assert client.stamps == [('tokens.bulk_delete', 'd1', 4), ('spans.update', 'd1', 4)]
    assert client.strict_mode_document_id is None


def test_every_service_that_locks_a_document_writes_in_strict_mode():
    """Every path in: a service or workflow that takes the lock itself would
    write unstamped, and a late batch of its own could land over an edit."""
    import pathlib
    repo = pathlib.Path(__file__).resolve().parents[2]
    sources = [*repo.glob('plaid-*/services/*.py'),
               *(repo / 'plaid-client-py/src/plaid_client/workflows').rglob('*.py')]
    sources = [p for p in sources if 'plaid-core' not in p.parts]
    assert len(sources) > 10
    bare = [str(p.relative_to(repo)) for p in sources if 'documents.locked(' in p.read_text()]
    assert bare == [], 'take the lock through plaid_client.service.locked_for_writes'


# --- held_run: the whole run under the lock (R15, R17) ---------------------------

class _Helper:
    def __init__(self, client):
        self.client, self.sent = client, []
        self.depth = 0

    def progress(self, percent, message):
        self.sent.append(('progress', percent, message, self.depth))

    def error(self, message):
        self.sent.append(('error', message, self.client.strict_mode_document_id))

    def complete(self, result):
        # What the requester reads, and whether the document was free by then.
        self.sent.append(('complete', result, self.client.strict_mode_document_id))

    def critical(self):
        import contextlib

        @contextlib.contextmanager
        def block():
            self.depth += 1
            try:
                yield
            finally:
                self.depth -= 1
        return block()


def test_a_held_run_sends_its_result_once_the_document_is_let_go():
    from plaid_client.service import held_run
    client = FakeClient([{'id': 'd1', 'version': 4}])
    helper = _Helper(client)
    with held_run(client, helper, 'd1') as run:
        assert client.strict_mode_document_id == 'd1'
        client.spans.update('s1', 'NOUN')
        run.result = {'status': 'success', 'words_written': 1}
    assert client.kinds[0] == 'lock' and client.kinds[-1] == 'unlock'
    # The report is not a checkpoint (inside a critical block), and it goes
    # after the unlock.
    assert helper.sent == [('progress', 100, 'Done', 1),
                           ('complete', {'status': 'success', 'words_written': 1}, None)]


def test_a_held_run_that_returns_early_still_sends_what_it_set():
    from plaid_client.service import held_run
    client = FakeClient([{'id': 'd1', 'version': 4}])
    helper = _Helper(client)

    def body():
        with held_run(client, helper, 'd1') as run:
            run.result = {'status': 'success', 'words_written': 0}
            return
    body()
    assert [s[0] for s in helper.sent] == ['progress', 'complete']


def test_a_held_run_that_reported_a_refusal_or_failed_sends_nothing_more():
    from plaid_client.service import held_run
    client = FakeClient([{'id': 'd1', 'version': 4}])
    helper = _Helper(client)
    with held_run(client, helper, 'd1'):
        pass                                   # refused, and said so itself
    assert helper.sent == []
    with pytest.raises(RuntimeError):
        with held_run(client, helper, 'd1') as run:
            run.result = {'status': 'success'}
            raise RuntimeError('boom')
    assert helper.sent == []
    assert client.kinds[-1] == 'unlock'


def test_a_held_run_sends_its_refusal_once_the_document_is_let_go():
    # REV-W3-SVC F7: the requester's app unlocks on the answer, so a refusal
    # sent under the lock met a 423 on the person's next write.
    from plaid_client.service import held_run
    client = FakeClient([{'id': 'd1', 'version': 4}])
    helper = _Helper(client)
    with held_run(client, helper, 'd1') as run:
        run.refusal = 'The document has no gloss field.'
    assert client.kinds[-1] == 'unlock'
    assert helper.sent == [('error', 'The document has no gloss field.', None)]


# --- a service file older than the client stops before its work (REV-W3-SVC F4) -

def test_an_old_umr_drafting_service_fails_at_import_with_the_reason():
    with pytest.raises(ImportError, match='older than plaid-client'):
        exec('from plaid_client.workflows.umr import DraftProgress, begin_draft', {})


def test_the_media_is_not_downloaded_with_no_document_held(tmp_path):
    from plaid_client.workflows.asr.alignment_processor import AlignmentProcessor
    client = FakeClient([{'id': 'd1', 'version': 4}])
    with pytest.raises(RuntimeError, match='older than plaid-client'):
        AlignmentProcessor().download_media_file(client, 'http://x/media', str(tmp_path))
