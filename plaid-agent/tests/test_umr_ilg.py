"""The assistant reads the gloss-line mapping through plaid_client's port of
ilg.js, the one the skeleton service and its node mirror test use, so a layer
gone from the mapping falls back to the proposal as it does on the canvas."""

import copy

from umr_fixtures import GLOSS_LAYER, PID, project_raw, umr_client

from plaid_agent.umr.project import gloss_headers, load_project, propose_ilg, resolve_ilg
from plaid_client.workflows.umr import layers as umr_layers


def _project(ilg=None, lang='en'):
    raw = project_raw()
    raw['text_layers'][0]['token_layers'][1]['span_layers'][0]['config']['igt']['lang'] = lang
    if ilg is not None:
        raw['config']['umr']['ilg'] = ilg
    return load_project(umr_client(project=raw), PID)


def test_a_mapping_whose_layer_is_gone_takes_the_proposed_layer():
    # A copied project: the mapping still names the original's layer id.
    project = _project(ilg=[{'header': 'word-gloss', 'lang': 'en', 'source': 'layer:gone'},
                            {'header': None, 'lang': None, 'source': 'stored'}])
    assert resolve_ilg(project)[0] == {'header': 'word-gloss', 'lang': 'en',
                                       'source': f'layer:{GLOSS_LAYER}'}


def test_the_proposal_takes_the_language_code_as_the_app_does():
    assert propose_ilg(_project(lang='pt-BR'))[0]['lang'] == 'pt'


def test_the_assistant_and_the_client_resolve_every_mapping_alike():
    configs = [None, [],
               [{'header': 'pos', 'lang': None, 'source': f'layer:{GLOSS_LAYER}'},
                {'header': 'word-gloss', 'lang': 'fr', 'source': 'layer:gone'}]]
    for config in configs:
        project = _project(ilg=copy.deepcopy(config))
        assert resolve_ilg(project) == umr_layers.resolve_ilg(config, project.layers)
    assert gloss_headers(_project()) == ['Word Gloss']
