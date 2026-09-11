"""Seed the fixture project into a running Plaid core so the query path can
be exercised for real (the fake client has no query engine). Tests that use
this skip when no server answers at PLAID_TEST_URL (default
http://localhost:8085) with the dev account."""

import os
import urllib.request

import pytest

URL = os.environ.get('PLAID_TEST_URL', 'http://localhost:8085')
USER = os.environ.get('PLAID_TEST_USER', 'a@b.com')
PASSWORD = os.environ.get('PLAID_TEST_PASSWORD', 'password')

OVERLAP = {'sentence': 'partitioning', 'word': 'non-overlapping', 'morpheme': 'any'}


def reachable() -> bool:
    try:
        urllib.request.urlopen(URL + '/api/v1/login', timeout=2)
    except urllib.error.HTTPError:
        return True  # any HTTP answer means a server is there
    except Exception:
        return False
    return True


def login():
    from plaid_client import PlaidClient
    return PlaidClient.login(URL, USER, PASSWORD)


class Seeded:
    """A real project built from fixture-shaped dicts. ``ids`` maps every
    fixture id (layers, tokens, spans, links, items, documents) to the real one."""

    def __init__(self, client, project_raw: dict, documents: dict, lexicons: dict, name: str):
        self.client = client
        self.ids: dict = {}
        self.vocab_ids: list = []
        self.roles: dict = {}  # fixture token layer id -> role
        c = client
        p = c.projects.create(name)
        self.project_id = p['id']
        for ns, cfg in (project_raw.get('config') or {}).items():
            for k, v in cfg.items():
                c.projects.set_config(self.project_id, ns, k, v)
        for v in project_raw.get('vocabs') or []:
            real = c.vocab_layers.create(v['name'])
            self.ids[v['id']] = real['id']
            self.vocab_ids.append(real['id'])
            c.projects.link_vocab(self.project_id, real['id'])
            for ns, cfg in (v.get('config') or {}).items():
                for k, val in cfg.items():
                    c.vocab_layers.set_config(real['id'], ns, k, val)
            for it in (lexicons.get(v['id']) or {}).get('items') or []:
                real_it = c.vocab_items.create(real['id'], it['form'], it.get('metadata') or {})
                self.ids[it['id']] = real_it['id']
        for tl in project_raw['text_layers']:
            real_tl = c.text_layers.create(self.project_id, tl['name'])
            self.ids[tl['id']] = real_tl['id']
            self._configs(c.text_layers, real_tl['id'], tl.get('config'))
            for tk in tl.get('token_layers') or []:
                role = ((tk.get('config') or {}).get('plaid') or {}).get('role')
                parent = None
                if role == 'word':
                    parent = next((self.ids[x['id']] for x in tl['token_layers']
                                   if ((x.get('config') or {}).get('plaid') or {}).get('role') == 'sentence'), None)
                elif role == 'morpheme':
                    parent = next((self.ids[x['id']] for x in tl['token_layers']
                                   if ((x.get('config') or {}).get('plaid') or {}).get('role') == 'word'), None)
                kw = {'overlap_mode': OVERLAP.get(role, 'any')}
                if parent:
                    kw['parent_token_layer_id'] = parent
                real_tk = c.token_layers.create(real_tl['id'], tk['name'], **kw)
                self.ids[tk['id']] = real_tk['id']
                self.roles[tk['id']] = role
                self._configs(c.token_layers, real_tk['id'], tk.get('config'))
                for sl in tk.get('span_layers') or []:
                    real_sl = c.span_layers.create(real_tk['id'], sl['name'])
                    self.ids[sl['id']] = real_sl['id']
                    self._configs(c.span_layers, real_sl['id'], sl.get('config'))
        for fid, raw in documents.items():
            self._document(fid, raw)

    def _configs(self, resource, real_id, config):
        for ns, cfg in (config or {}).items():
            for k, v in cfg.items():
                resource.set_config(real_id, ns, k, v)

    def _document(self, fid, raw):
        c = self.client
        d = c.documents.create(self.project_id, raw['name'], raw.get('metadata') or None)
        self.ids[fid] = d['id']
        for tl in raw['text_layers']:
            text = tl.get('text') or {}
            t = c.texts.create(self.ids[tl['id']], d['id'], text.get('body') or '')
            self.ids[text['id']] = t['id']
            layers = tl.get('token_layers') or []
            # Sentences first (partitioning: bulk only), then words, then morphemes.
            order = sorted(layers, key=lambda tk: ('sentence', 'word', 'morpheme').index(self.roles.get(tk['id'], 'morpheme')))
            for tk in order:
                real_layer = self.ids[tk['id']]
                toks = tk.get('tokens') or []
                if self.roles.get(tk['id']) == 'sentence':
                    # A partition tiles the text: fill the fixture's gaps as the
                    # server's own gap-fill would (each sentence runs to the next).
                    ordered = sorted(toks, key=lambda x: x['begin'])
                    ranges = []
                    for i, x in enumerate(ordered):
                        b = 0 if i == 0 else ordered[i - 1]['end'] if False else ranges[-1][1]
                        e = ordered[i + 1]['begin'] if i + 1 < len(ordered) else len(text.get('body') or '')
                        ranges.append((b, e))
                    res = c.tokens.bulk_create([{'token_layer_id': real_layer, 'text': t['id'], 'begin': b, 'end': e}
                                                for (b, e) in ranges])
                    toks = ordered
                    created = res.get('ids') if isinstance(res, dict) else res
                    for x, rid in zip(toks, created):
                        self.ids[x['id']] = rid if isinstance(rid, str) else rid.get('id')
                else:
                    for x in toks:
                        kw = {}
                        if x.get('precedence') is not None:
                            kw['precedence'] = x['precedence']
                        if x.get('metadata'):
                            kw['metadata'] = x['metadata']
                        r = c.tokens.create(real_layer, t['id'], x['begin'], x['end'], **kw)
                        self.ids[x['id']] = r['id']
            for tk in order:
                for sl in tk.get('span_layers') or []:
                    for sp in sl.get('spans') or []:
                        r = c.spans.create(self.ids[sl['id']], [self.ids[x] for x in sp['tokens']], sp.get('value'),
                                           sp.get('metadata') or {})
                        self.ids[sp['id']] = r['id']
                for v in tk.get('vocabs') or []:
                    for link in v.get('vocab_links') or []:
                        item = self.ids[link['vocab_item']['id']]
                        r = c.vocab_links.create(item, [self.ids[x] for x in link['tokens']], link.get('metadata') or {})
                        self.ids[link['id']] = r['id']

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


@pytest.fixture(scope='module')
def live_client():
    if not reachable():
        pytest.skip(f'no Plaid server at {URL}')
    try:
        return login()
    except Exception as e:  # noqa: BLE001
        pytest.skip(f'cannot log in at {URL}: {e}')
