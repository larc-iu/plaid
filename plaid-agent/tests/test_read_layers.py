"""What a document read asks the server for, and when a walk reads ahead.

Both apps know exactly which layers they parse, so a read names them and the
server never fetches, serializes or compresses the rest. A project may hold
layers this app never looks at: a relation layer under IGT, a gloss layer
under UD, anything the other app put there when the two share a project.

The rule the names have to satisfy is the server's: a layer carries its own
content only when it is NAMED (an ancestor comes back as scaffolding, empty),
so a token layer has to be named for its tokens, a text layer for the text
body, and a span layer for its spans.
"""

from fixtures import FakeClient, scan_ws
from ud_fixtures import PID, ud_client

from plaid_agent.igt.project import load_project as load_igt_project
from plaid_agent.ud.project import load_project as load_ud_project
from plaid_agent.ud.tools import Workspace as UdWorkspace


# --- what is named ------------------------------------------------------------

def test_igt_names_every_layer_it_parses():
    c = FakeClient()
    p = load_igt_project(c, 'p1')
    named = set(p.read_layer_ids())
    assert p.text_layer_id in named, 'the text layer, or the read carries no text body'
    for tokens in (p.sentence_layer_id, p.word_layer_id, p.morpheme_layer_id):
        if tokens:
            assert tokens in named, 'a token layer, or no tokens and no vocab links come back'
    for f in p.fields.values():
        assert f.layer_id in named, f'the span layer behind field "{f.name}"'


def test_ud_names_every_layer_it_parses():
    c = ud_client()
    p = load_ud_project(c, PID)
    named = set(p.read_layer_ids())
    assert p.text_layer_id in named
    for tokens in (p.sentence_layer_id, p.token_layer_id, p.word_layer_id):
        assert tokens in named
    for field, layer_id in p.span_layers.items():
        assert layer_id in named, f'the span layer behind "{field}"'
    if p.relation_layer_id:
        assert p.relation_layer_id in named, 'the relation layer, or there are no dependency arcs'


def test_a_layer_this_app_does_not_parse_is_not_asked_for():
    """The point of naming them. A project shared with the other app, or one
    with a layer nobody scoped, carries layers the parse walks straight past,
    and the read must not pay for them."""
    from fixtures import project_raw
    raw = project_raw()
    words = raw['text_layers'][0]['token_layers'][1]
    # A span layer with no IGT scope: `_spans_by_token` skips it, so nothing
    # in a parsed document ever comes from it.
    words['span_layers'].append({'id': 'sl-foreign', 'name': 'Someone Else', 'config': {}})
    # And a relation layer, which this app does not read at all.
    words['span_layers'][0]['relation_layers'] = [{'id': 'rl-deps', 'name': 'deps', 'config': {}}]
    named = set(load_igt_project(FakeClient(project=raw), 'p1').read_layer_ids())
    assert 'sl-foreign' not in named
    assert 'rl-deps' not in named


def test_no_layer_is_named_twice():
    ids = load_igt_project(FakeClient(), 'p1').read_layer_ids()
    assert len(ids) == len(set(ids)) and all(ids)


# --- what the read asks for ---------------------------------------------------

def test_an_igt_document_read_asks_for_those_layers_only():
    c = FakeClient()
    w = scan_ws(c)
    w.doc('d1')
    assert c.doc_reads, 'the document was read'
    did, layers = c.doc_reads[-1]
    assert did == 'd1'
    assert layers is not None and set(layers) == set(w.project.read_layer_ids())


def test_a_ud_document_read_asks_for_those_layers_only():
    c = ud_client()
    w = UdWorkspace(c, load_ud_project(c, PID))
    w.doc(next(d['id'] for d in w.documents()))
    assert c.doc_reads, 'the document was read'
    _, layers = c.doc_reads[-1]
    assert layers is not None and set(layers) == set(w.project.read_layer_ids())


# --- when a walk reads ahead --------------------------------------------------

def _doc_at(i: int):
    from fixtures import document_raw
    raw = document_raw()
    raw['id'] = f'd{i}'
    raw['name'] = f'Text {i}'
    raw['version'] = 1
    return raw


def test_the_sandbox_reads_ahead_only_once_a_run_is_walking(fresh_document_cache):
    """One document is a question about one document. From the second the run
    is walking the corpus, and the rest of the list is started in the
    background instead of being waited for one at a time."""
    from plaid_agent.core import sandbox

    c = FakeClient(documents={f'd{i}': _doc_at(i) for i in range(4)})
    c.no_doc_cache = False
    w = scan_ws(c)
    load = sandbox.load_proxy(w, lambda doc: doc)
    try:
        load('d0')
        assert not w.reader.walking(), 'one document is not a walk'
        assert not w.reader._read_ahead_done, 'so nothing else was started'

        load('d1')
        assert w.reader.walking() and w.reader._read_ahead_done, 'the rest of the list was started'

        load('d2')
        load('d3')
        reads = sorted(did for did, _ in c.doc_reads)
        assert reads == ['d0', 'd1', 'd2', 'd3'], 'every document read exactly once'
    finally:
        w.close()
