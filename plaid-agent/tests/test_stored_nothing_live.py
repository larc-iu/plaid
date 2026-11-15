"""On the core (FX): a word whose lone stored morpheme holds nothing of its
own (no form, no type, no value, no link) is given an analysis, approved as
a person approves it. The morpheme written holds the form and the gloss, as
the assistant-job-discuss e2e spec expects of a fresh "kai pele tuna"."""

import pytest

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


#: The three analysis tools, each as the reviewer's probe drove it on a word
#: whose morpheme holds nothing (REV-DAY-S-8, scripts/REV-DAY/safety_s2.py,
#: safety_s4.py: Half s3.w2 "gam" among them).
TOOLS = {
    'analyze_sentence': ('analyze_sentence', {'sentences': [{'ref': 's1.w2', 'words': ['gam fish']}]}),
    'set_analysis': ('set_analysis', {'ref': 's1.w2', 'morphemes': [{'form': 'gam', 'fields': {'Morph Gloss': 'fish'}}]}),
    'set_analysis_for_form': ('set_analysis_for_form', {'form': 'gam', 'morphemes': [
        {'form': 'gam', 'fields': {'Morph Gloss': 'fish'}}]}),
}


@pytest.mark.parametrize('tool', sorted(TOOLS))
def test_a_job_writes_the_form_and_its_stamp_on_such_a_word_on_the_core(live_client, tool):
    """As a job applies (the machine stamp): the segmentation is the job's,
    form and provenance on the morpheme, never a person's with no form."""
    s = seed(live_client, project(), {'d1': doc()}, {VOCAB: lexicon_raw()}, name=f'fx stored nothing {tool}')
    try:
        ws, w = _gam(live_client, s.project_id)
        name, args = TOOLS[tool]
        doc_args = {} if name == 'set_analysis_for_form' else {'document': ws.documents()[0]['name']}
        call_tool(ws, name, {**doc_args, **args})
        execute_plan(live_client, ws.plan_payload()['ops'], source='service:igt:job', label='t', stamp_mode='machine',
                     detail={'job': 'fx-stored-nothing'})
        _ws, w = _gam(live_client, s.project_id)
        (m,) = w.morphemes
        assert m.metadata.get('form') == 'gam', m.metadata
        assert m.metadata.get('prov') == 'inferred', m.metadata
        assert sorted(sp.value for sp in m.fields.values()) == ['fish']
    finally:
        s.delete()


@pytest.mark.parametrize('mode', ['machine', 'verified', 'unverified'])
def test_the_form_written_inside_a_kept_chain_carries_the_writers_stamp_on_the_core(live_client, mode):
    """REV-DF3-1: a person's "ga" 'fish' then a morpheme holding nothing,
    given back as ga-m fish-SG, as a job applies it and as a chat plan
    approved either way: the chain is kept, the person's morpheme untouched,
    and the form written on the empty one is stamped as its gloss is."""
    from test_stored_nothing import _gloss, _morph, _token
    raw = doc()
    m2 = _token(raw, 'm-2')
    m2['metadata'] = {'form': 'ga'}
    _morph(raw)['tokens'].append({'id': 'm-2z', 'begin': m2['begin'], 'end': m2['end'], 'precedence': 2,
                                  'metadata': {}})
    _gloss(raw, 'm-2', 'fish')
    s = seed(live_client, project(), {'d1': raw}, {VOCAB: lexicon_raw()}, name=f'df4 chain form {mode}')
    try:
        ws, w = _gam(live_client, s.project_id)
        call_tool(ws, 'set_analysis', {'document': ws.documents()[0]['name'], 'ref': 's1.w2', 'morphemes': [
            {'form': 'ga', 'fields': {'Morph Gloss': 'fish'}}, {'form': 'm', 'fields': {'Morph Gloss': 'SG'}}]})
        source = 'service:igt:job' if mode == 'machine' else 'service:igt:assist'
        execute_plan(live_client, ws.plan_payload()['ops'], source=source, label='t', stamp_mode=mode,
                     detail={'job': 'df4'} if mode == 'machine' else None)
        _ws, w = _gam(live_client, s.project_id)
        first, second = w.morphemes
        assert first.metadata.get('form') == 'ga' and 'prov' not in first.metadata, first.metadata
        assert second.metadata.get('form') == 'm', second.metadata
        assert second.metadata.get('prov') == 'inferred' and second.metadata.get('provSource') == source, \
            second.metadata
        assert bool(second.metadata.get('provConfirmed')) == (mode == 'verified'), second.metadata
    finally:
        s.delete()
