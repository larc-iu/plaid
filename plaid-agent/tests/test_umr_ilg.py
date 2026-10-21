"""The assistant reads the gloss-line mapping through plaid_client's port of
ilg.js, the one the skeleton service and its node mirror test use: the
project's stored mapping alone, never a line proposed from a layer's name."""

import copy

from umr_fixtures import GLOSS_LAYER, PID, project_raw, umr_client

from plaid_agent.umr.project import gloss_headers, load_project, resolve_ilg
from plaid_client.workflows.umr import layers as umr_layers


def _project(ilg=None, lang='en'):
    raw = project_raw()
    raw['text_layers'][0]['token_layers'][1]['span_layers'][0]['config']['igt']['lang'] = lang
    raw['config']['umr'].pop('ilg', None)
    if ilg is not None:
        raw['config']['umr']['ilg'] = ilg
    return load_project(umr_client(project=raw), PID)


def test_a_mapping_whose_layer_is_gone_keeps_it_and_draws_nothing():
    # A restored project: the mapping still names the original's layer id.
    gone = {'header': 'word-gloss', 'lang': 'en', 'source': 'layer:gone'}
    project = _project(ilg=[gone, {'header': None, 'lang': None, 'source': 'stored'}])
    assert resolve_ilg(project)[0] == gone


def test_a_project_without_a_mapping_has_no_gloss_lines():
    project = _project()
    assert resolve_ilg(project) == []
    assert gloss_headers(project) == []


def test_the_assistant_and_the_client_resolve_every_mapping_alike():
    configs = [None, [],
               [{'header': 'pos', 'lang': None, 'source': f'layer:{GLOSS_LAYER}'},
                {'header': 'word-gloss', 'lang': 'fr', 'source': 'layer:gone'}]]
    for config in configs:
        project = _project(ilg=copy.deepcopy(config))
        assert resolve_ilg(project) == umr_layers.resolve_ilg(config)
    mapped = _project(ilg=[{'header': 'word-gloss', 'lang': 'en',
                            'source': f'layer:{GLOSS_LAYER}'}])
    assert gloss_headers(mapped) == ['Word Gloss']
