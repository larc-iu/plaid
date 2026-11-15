"""On the core (FX): a word whose lone stored morpheme holds nothing of its
own (no form, no type, no value, no link) is given an analysis, approved as
a person approves it. The morpheme written holds the form and the gloss, as
the assistant-job-discuss e2e spec expects of a fresh "kai pele tuna"."""

from live import live_client, seed  # noqa: F401
from fixtures import VOCAB, lexicon_raw
from test_restated_analysis import doc, project

from plaid_agent.igt.plan import execute_plan
from plaid_agent.igt.project import load_project
from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.workspace import Workspace


def _gam(c, pid):
    ws = Workspace(c, load_project(c, pid))
    return ws, ws.doc(ws.documents()[0]['id']).sentences[0].words[1]


def test_a_word_whose_morpheme_holds_nothing_gets_its_form_and_gloss_on_the_core(live_client):
    s = seed(live_client, project(), {'d1': doc()}, {VOCAB: lexicon_raw()}, name='fx stored nothing')
    try:
        ws, w = _gam(live_client, s.project_id)
        (m,) = w.morphemes
        assert not m.virtual and m.metadata.get('form') is None and not m.fields
        call_tool(ws, 'set_analysis', {'document': ws.documents()[0]['name'], 'ref': 's1.w2',
                                       'morphemes': [{'form': 'gam', 'fields': {'Morph Gloss': 'fish'}}]})
        execute_plan(live_client, ws.plan_payload()['ops'], source='service:igt:assist', label='t')
        _ws, w = _gam(live_client, s.project_id)
        assert [(m.metadata.get('form'), sorted(sp.value for sp in m.fields.values())) for m in w.morphemes] == \
            [('gam', ['fish'])]
    finally:
        s.delete()
