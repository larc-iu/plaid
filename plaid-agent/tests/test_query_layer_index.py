"""What each app's `query` lets the model name a layer by. One walk of the
project in core (`core.query.layer_index`), with each app's own names on top.

igt's own walk looked for relation layers on token layers, where core never
puts them (they sit under span layers), so in a project shared with UD or UMR
an igt query could not name a relation layer at all."""

import copy

from fixtures import FakeClient, project_raw, fake_ws

from plaid_agent.core.query import display
from plaid_agent.igt.query import _layer_index


def _shared_project():
    raw = copy.deepcopy(project_raw())
    words = raw['text_layers'][0]['token_layers'][1]
    words['span_layers'][0]['relation_layers'] = [{'id': 'rl-dep', 'name': 'Dependencies'}]
    return raw


def test_igt_names_a_relation_layer_under_a_span_layer():
    idx = _layer_index(fake_ws(FakeClient(project=_shared_project())))
    assert idx['dependencies'] == [('relation-layer', 'rl-dep', 'Dependencies')]


def test_igt_names_its_layers_by_its_own_words_too():
    idx = _layer_index(fake_ws(FakeClient()))
    assert idx['words'] == [('token-layer', 'tk-word', 'Words')]
    assert idx['baseline'][0][1] == 'tl'
    assert idx['lexicon'] == [('vocab-layer', 'v1', 'Lexicon')]
    # A refusal names a field by its IGT name, which says its scope where two
    # scopes share a layer name.
    ws = fake_ws(FakeClient())
    assert display(idx)('sl-gloss') == ws.project.field_by_layer('sl-gloss').name
