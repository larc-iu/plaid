"""The real Plaid core the tests read through: one per test session, booted
on first use (``private_core.py``), with the fixture projects seeded into it.

The fake client runs no queries, so every corpus-wide igt tool asks this core.
Two ways in:

- ``live_client`` (a session fixture) is a client logged in to it, for a test
  that builds a real project with :func:`seed` and reads it back through the
  real API.
- :func:`answer` is what the igt fake client's ``query`` does with a query it
  cannot run itself: the fake's project, as it stands, is seeded into the core
  (once per distinct state, kept for the session), the query is sent there
  with the fixture's ids turned into the core's, and the answer comes back
  with them turned back. The documents a tool loads are still the fake's, so a
  test reads and asserts in the fixture's ids.

A test that needs the core skips with the reason when none can run here, and
fails instead under ``PLAID_AGENT_REQUIRE_LIVE=1``.
"""

import atexit
import copy
import hashlib
import json
import os

import pytest
from plaid_client.ids import uuid7

import private_core

OVERLAP = {'sentence': 'partitioning', 'word': 'non-overlapping', 'morpheme': 'any',
           'time-alignment': 'non-overlapping'}
# The order a document's token layers are made in: sentences, words,
# morphemes, then any other (a time alignment).
LAYER_ORDER = {'sentence': 0, 'word': 1, 'morpheme': 2}


# These tests are the only coverage of the real query engine, and a skip turns
# them green having run nothing: on CI, or after a path moves, the suite still
# says every test passed. `PLAID_AGENT_REQUIRE_LIVE=1` makes the skip a
# failure, so a runner that means to exercise the engine can demand it.
def _skip_or_fail(why: str) -> None:
    if os.environ.get('PLAID_AGENT_REQUIRE_LIVE'):
        raise AssertionError(f'{why} (PLAID_AGENT_REQUIRE_LIVE is set)')
    pytest.skip(why)


# The same shape for the OTHER hard dependency a suite can be missing.
# pydantic-monty is a hard dependency of the package, so a missing worker
# binary is a broken install rather than a normal condition, and three whole
# modules disappear without a word when it is. The skip stays the default (a
# contributor's machine may genuinely not have it) and
# PLAID_AGENT_REQUIRE_SANDBOX=1 turns it into a failure.
def require_sandbox():
    """The module-level ``pytestmark`` for tests that need the code sandbox."""
    from plaid_agent.core import sandbox
    why = sandbox.available()
    if why and os.environ.get('PLAID_AGENT_REQUIRE_SANDBOX'):
        raise AssertionError(f'the code sandbox cannot run: {why} '
                             '(PLAID_AGENT_REQUIRE_SANDBOX is set)')
    return pytest.mark.skipif(why is not None, reason=why or '')


# --- the session's core ---------------------------------------------------------

class _Session:
    core = None        # the PrivateCore this session booted, if it did
    url = None
    user = None
    password = None
    admin = None       # a client logged in as the core's admin
    unavailable = None  # why no core can run here
    broken = None       # why the core failed to boot


def core_client():
    """A client logged in to the session's core, booting a private one on
    first use (or the one ``PLAID_TEST_URL`` names). Skips the test when no
    core can run here, and fails it when the core would not boot."""
    S = _Session
    if S.admin is not None:
        return S.admin
    if S.unavailable:
        _skip_or_fail(S.unavailable)
    if S.broken:
        raise RuntimeError(S.broken)
    from plaid_client import PlaidClient
    named = os.environ.get('PLAID_TEST_URL')
    if named:
        if not private_core.answers(named):
            S.unavailable = f'no Plaid server at PLAID_TEST_URL={named}'
            _skip_or_fail(S.unavailable)
        S.url = named
        S.user = os.environ.get('PLAID_TEST_USER', private_core.ADMIN_EMAIL)
        S.password = os.environ.get('PLAID_TEST_PASSWORD', private_core.ADMIN_PASSWORD)
    else:
        start_early()
        if S.unavailable:
            _skip_or_fail(S.unavailable)
        try:
            S.core.wait()
        except Exception as e:  # noqa: BLE001
            S.broken = str(e)
            stop()
            raise
        S.url, S.user, S.password = S.core.url, private_core.ADMIN_EMAIL, private_core.ADMIN_PASSWORD
    S.admin = PlaidClient.login(S.url, S.user, S.password)
    return S.admin


def start_early() -> None:
    """Start a private core booting, unless one is already up, or named by
    ``PLAID_TEST_URL``, or none can run here. :func:`core_client` waits for it."""
    S = _Session
    if S.core is not None or S.unavailable or S.broken or os.environ.get('PLAID_TEST_URL'):
        return
    try:
        S.core = private_core.PrivateCore()
    except private_core.Unavailable as e:
        S.unavailable = str(e)


def core_url() -> str:
    core_client()
    return _Session.url


def core_user() -> str:
    """The admin the session's client is logged in as (its id is its email)."""
    core_client()
    return _Session.user


def core_db():
    """The database file of the session's core: the private core's own, or
    the one PLAID_TEST_DB names for a core PLAID_TEST_URL names."""
    core_client()
    if _Session.core is not None:
        return str(_Session.core.dir / 'plaid.db')
    return os.environ.get('PLAID_TEST_DB')


def login():
    """A fresh client logged in to the session's core as its admin."""
    from plaid_client import PlaidClient
    core_client()
    return PlaidClient.login(_Session.url, _Session.user, _Session.password)


def stop() -> None:
    """Stop the core this session booted. A core PLAID_TEST_URL named is left running."""
    if _Session.core is not None:
        _Session.core.stop()
        _Session.core = None
    _Session.admin = None


atexit.register(stop)


@pytest.fixture(scope='session')
def live_client():
    return core_client()


class _Ids(dict):
    """fixture id -> real id, and in ``back`` every real id made -> its
    fixture id. Fixtures reuse token ids across documents, so the last one made
    under an id is what ``ids`` holds, while ``back`` holds every one."""

    def __init__(self):
        super().__init__()
        self.back: dict = {}

    def __setitem__(self, fixture, real):
        super().__setitem__(fixture, real)
        self.back[real] = fixture


class Seeded:
    """A real project built from fixture-shaped dicts. ``ids`` maps every
    fixture id (layers, tokens, spans, links, items, documents) to the real one.

    Every id is minted here, so the whole project goes in one batch after the
    project itself: a request per entity cost about a second per fixture."""

    def __init__(self, client, project_raw: dict, documents: dict, lexicons: dict, name: str):
        self.client = client
        self.ids = _Ids()
        self.vocab_ids: list = []
        self.roles: dict = {}  # fixture token layer id -> role
        self.project_id = client.projects.create(name, id=uuid7())['id']
        with client.batched() as b:
            self._layers(b, project_raw, lexicons)
            for fid, raw in documents.items():
                self._document(b, fid, raw)

    def _mint(self, fixture_id: str) -> str:
        self.ids[fixture_id] = uuid7()
        return self.ids[fixture_id]

    def _layers(self, b, project_raw: dict, lexicons: dict) -> None:
        pid = self.project_id
        self._configs(b.projects, pid, project_raw.get('config'))
        for v in project_raw.get('vocabs') or []:
            vid = self._vocab(b, v)
            self._configs(b.vocab_layers, vid, v.get('config'))
            for it in (lexicons.get(v['id']) or {}).get('items') or []:
                b.vocab_items.create(vid, it['form'], it.get('metadata') or {}, id=self._mint(it['id']))
        for tl in project_raw['text_layers']:
            tlid = self._mint(tl['id'])
            b.text_layers.create(pid, tl['name'], id=tlid)
            self._configs(b.text_layers, tlid, tl.get('config'))
            by_role = {((x.get('config') or {}).get('plaid') or {}).get('role'): x['id']
                       for x in tl.get('token_layers') or []}
            for tk in tl.get('token_layers') or []:
                role = ((tk.get('config') or {}).get('plaid') or {}).get('role')
                parent = {'word': 'sentence', 'morpheme': 'word'}.get(role)
                kw = {'overlap_mode': OVERLAP.get(role, 'any')}
                if parent in by_role:
                    kw['parent_token_layer_id'] = self.ids[by_role[parent]]
                tkid = self._mint(tk['id'])
                b.token_layers.create(tlid, tk['name'], id=tkid, **kw)
                self.roles[tk['id']] = role
                self._configs(b.token_layers, tkid, tk.get('config'))
                for sl in tk.get('span_layers') or []:
                    slid = self._mint(sl['id'])
                    b.span_layers.create(tkid, sl['name'], id=slid)
                    self._configs(b.span_layers, slid, sl.get('config'))

    def _vocab(self, b, v: dict) -> str:
        vid = self._mint(v['id'])
        b.vocab_layers.create(v.get('name') or v['id'], id=vid)
        b.projects.link_vocab(self.project_id, vid)
        self.vocab_ids.append(vid)
        return vid

    @staticmethod
    def _configs(resource, real_id, config):
        for ns, cfg in (config or {}).items():
            for k, v in cfg.items():
                resource.set_config(real_id, ns, k, v)

    def _document(self, b, fid, raw):
        did = self._mint(fid)
        # A fixture may hold two documents of one name, which core refuses: the
        # copy takes a free one. Queries answer in ids, so the copy's names
        # never reach a test, which reads the fake's.
        if raw.get('metadata'):
            b.documents.create(self.project_id, raw['name'], raw['metadata'], id=did, free_name=True)
        else:
            b.documents.create(self.project_id, raw['name'], id=did, free_name=True)
        for tl in raw['text_layers']:
            text = tl.get('text') or {}
            body = text.get('body') or ''
            tid = self._mint(text['id'])
            b.texts.create(self.ids[tl['id']], did, body, id=tid)
            layers = tl.get('token_layers') or []
            # Sentences first, then words, then morphemes.
            order = sorted(layers, key=lambda tk: LAYER_ORDER.get(self.roles.get(tk['id'], 'morpheme'), 3))
            for tk in order:
                layer = self.ids[tk['id']]
                toks = tk.get('tokens') or []
                if self.roles.get(tk['id']) == 'sentence':
                    # A partition tiles the text, and is made in one bulk
                    # create: the fixture's gaps are filled as the server's
                    # own gap-fill would (each sentence runs to the next).
                    toks = sorted(toks, key=lambda x: x['begin'])
                    ends = [x['begin'] for x in toks[1:]] + [len(body)]
                    begins = [0] + ends[:-1]
                    b.tokens.bulk_create([{'id': self._mint(x['id']), 'token_layer_id': layer, 'text': tid,
                                           'begin': bg, 'end': e} for x, bg, e in zip(toks, begins, ends)])
                    continue
                for x in toks:
                    kw = {}
                    if x.get('precedence') is not None:
                        kw['precedence'] = x['precedence']
                    if x.get('metadata'):
                        kw['metadata'] = x['metadata']
                    b.tokens.create(layer, tid, x['begin'], x['end'], id=self._mint(x['id']), **kw)
            for tk in order:
                for sl in tk.get('span_layers') or []:
                    for sp in sl.get('spans') or []:
                        tokens = [self.ids[x] for x in sp['tokens']]
                        b.spans.create(self.ids[sl['id']], tokens, sp.get('value'), sp.get('metadata') or {},
                                       id=self._mint(sp['id']))
                for v in tk.get('vocabs') or []:
                    for link in v.get('vocab_links') or []:
                        item = self._item(b, v, link['vocab_item'])
                        tokens = [self.ids[x] for x in link['tokens']]
                        b.vocab_links.create(item, tokens, link.get('metadata') or {}, id=self._mint(link['id']))

    def _item(self, b, vocab, item):
        """The real id of a link's entry, made in its vocabulary when no
        lexicon of the fixture holds it."""
        if not isinstance(item, dict):
            item = {'id': item}
        if item['id'] not in self.ids:
            if vocab['id'] not in self.ids:
                self._vocab(b, vocab)
            b.vocab_items.create(self.ids[vocab['id']], item.get('form') or '', {}, id=self._mint(item['id']))
        return self.ids[item['id']]

    def delete(self):
        try:
            self.client.projects.delete(self.project_id)
        finally:
            for vid in self.vocab_ids:
                try:
                    self.client.vocab_layers.delete(vid)
                except Exception:
                    pass


def seed(client, project_raw, documents, lexicons, name='igt-agent test'):
    # Leftovers of an earlier failed run under the same name go first.
    for p in client.projects.list() or []:
        if p.get('name') == name:
            try:
                client.projects.delete(p['id'])
            except Exception:
                pass
    s = Seeded.__new__(Seeded)
    try:
        Seeded.__init__(s, client, project_raw, documents, lexicons, name)
    except Exception:
        if getattr(s, 'project_id', None):
            s.delete()
        raise
    return s


# --- the fake client's queries, answered by the core ------------------------------

_mirrors: dict = {}  # digest of a fake project's state -> its Seeded copy in the core


def _lexicons_of(fake) -> dict:
    by_id = getattr(fake, '_lexicons_by_id', None)
    if by_id:
        return by_id
    lex = getattr(fake, '_lexicon', None)
    return {lex['id']: lex} if lex else {}


def _state(fake, project_id):
    """(project, documents by id, lexicons by id) the fake holds for a project."""
    own = (fake.project or {}).get('id')
    if project_id in (None, own) or fake.other_projects is None or project_id not in fake.other_projects:
        docs = fake._documents if isinstance(fake._documents, dict) else {}
        return fake.project, docs, _lexicons_of(fake)
    spec = fake.other_projects[project_id]
    return spec['project'], spec['documents'], _lexicons_of(fake)


def mirror(fake, project_id=None) -> 'Seeded':
    """The core's copy of the fake's project as it stands now, seeded the
    first time this state is asked for and kept for the session."""
    project, documents, lexicons = _state(fake, project_id)
    wanted = {v['id'] for v in project.get('vocabs') or []}
    lexicons = {vid: lex for vid, lex in lexicons.items() if vid in wanted}
    key = hashlib.sha256(json.dumps([project, documents, lexicons], sort_keys=True, default=str)
                         .encode()).hexdigest()
    s = _mirrors.get(key)
    if s is None:
        client = core_client()
        try:
            s = Seeded(client, project, documents, lexicons, f'mirror {key[:12]}')
        except Exception as e:  # noqa: BLE001 - a fixture the core refuses is the test's failure, not the tool's
            pytest.fail(f'the core refused the fixture project: {e}', pytrace=False)
        s.ids[project['id']] = s.project_id
        s.answers = {}
        _mirrors[key] = s
    return s


def _translate(value, ids: dict):
    if isinstance(value, str):
        return ids.get(value, value)
    if isinstance(value, list):
        return [_translate(v, ids) for v in value]
    if isinstance(value, dict):
        return {k: _translate(v, ids) for k, v in value.items()}
    return value


def answer(fake, body: dict) -> dict:
    """What the core answers ``body`` with, asked over the fake's project and
    in the fake's ids. A copy is never written to, so the same query over the
    same copy is asked once a session."""
    pids = (body.get('scope') or {}).get('project_ids') or [None]
    s = mirror(fake, pids[0])
    key = json.dumps(body, sort_keys=True, default=str)
    if key not in s.answers:
        s.answers[key] = _translate(core_client().query(_translate(body, s.ids)), s.ids.back)
    return copy.deepcopy(s.answers[key])
