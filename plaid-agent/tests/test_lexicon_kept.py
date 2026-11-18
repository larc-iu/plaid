"""A lexicon is read whole once and kept between turns and job pieces, for as
long as core's record of it says it has not changed (SCL2-6: a job read the
8,000-entry lexicon, 1.6 MB, about twice a piece, 1,367 times in one job)."""
import pytest
from fixtures import FakeClient, fake_ws, lexicon_raw


@pytest.fixture
def kept():
    from plaid_agent.igt import workspace
    workspace._LEXICONS.clear()
    yield workspace._LEXICONS
    workspace._LEXICONS.clear()


def _client(time='2026-11-18T05:34:23Z'):
    """The fake client, its lexicon stamped with ``time``, and the list of
    what each read of it asked for."""
    reads = []

    class Counting(FakeClient._VocabLayers):
        def get(self, vid, include_items=None, **kw):
            reads.append('items' if include_items else 'head')
            got = super().get(vid, include_items=include_items, **kw)
            return got if include_items else {k: v for k, v in got.items() if k != 'items'}

    class Client(FakeClient):
        @property
        def vocab_layers(self):
            return Counting(self)
    c = Client()
    # The fake opts out of the caches (fixtures reuse ids): this test opts in.
    c.no_doc_cache = False
    c._lexicon = {**lexicon_raw(), 'time_modified': time}
    return c, reads


def test_a_second_workspace_reads_only_the_lexicons_record_while_it_is_unchanged(kept):
    c, reads = _client()
    v = c._lexicon
    first = fake_ws(c).lexicon(v)
    assert reads == ['head', 'items']
    reads.clear()
    again = fake_ws(c).lexicon(v)
    assert reads == ['head']
    assert [it['id'] for it in again] == [it['id'] for it in first]
    # A change to the lexicon moves its time: read whole again.
    c._lexicon = {**lexicon_raw(), 'time_modified': '2026-11-18T06:00:00Z',
                  'items': lexicon_raw()['items'][:2]}
    reads.clear()
    assert [it['id'] for it in fake_ws(c).lexicon(v)] == ['vi-ali', 'vi-erg']
    assert reads == ['head', 'items']


def test_a_lexicon_with_no_time_or_a_client_that_opts_out_is_never_kept(kept):
    c, reads = _client(time=None)
    fake_ws(c).lexicon(c._lexicon)
    fake_ws(c).lexicon(c._lexicon)
    assert reads.count('items') == 2
    c, reads = _client()
    c.no_doc_cache = True
    fake_ws(c).lexicon(c._lexicon)
    fake_ws(c).lexicon(c._lexicon)
    assert reads == ['items', 'items']


def test_what_one_workspace_stages_on_an_entry_is_not_seen_by_another(kept):
    c, _reads = _client()
    v = c._lexicon
    a = fake_ws(c)
    a.patch_item('vi-gam', {'gloss': 'FISH'})
    assert any((it.get('metadata') or {}).get('gloss') == 'FISH' for it in a.view(v).items)
    b = fake_ws(c)
    assert [(it.get('metadata') or {}).get('gloss') for it in b.lexicon(v) if it['id'] == 'vi-gam'] == ['fish']
    b.lexicon(v).append({'id': 'extra'})
    assert 'extra' not in [it['id'] for it in fake_ws(c).lexicon(v)]
