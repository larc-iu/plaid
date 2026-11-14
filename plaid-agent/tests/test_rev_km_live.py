"""REV-KM-1 on the core: a person's word with a proclitic, a clitic in the
middle, or both, given back to analyze_sentence exactly as the read shows it,
is written as a job writes (execute_plan, the machine stamp). Every morpheme
keeps its id, its type, its values and their provenance: nothing of the
analysis is written (a link to the one entry fitting an unlinked morpheme may
be)."""

import pytest

from live import live_client, seed  # noqa: F401
from fixtures import VOCAB, lexicon_raw
from test_rev_km import w1_doc
from test_restated_analysis import project

from plaid_agent.igt.plan import execute_plan
from plaid_agent.igt.project import load_project, segmentation
from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.workspace import Workspace

WORDS = {
    'proclitic': ([('ma', 'ku', 'proclitic', False, 'DEM'), ('mb', 'gam', None, False, 'fish')], 'ku=gam', 'DEM=fish'),
    'mid-word': ([('ma', 'Gam', None, False, 'fish'), ('mb', 'ar', 'enclitic', False, 'FOC'),
                  ('mc', 'i', 'suffix', False, 'PL')], 'Gam=ar=i', 'fish=FOC=PL'),
    'both': ([('ma', 'ku', 'proclitic', False, 'DEM'), ('mb', 'gam', None, False, 'fish'),
              ('mc', 'ar', 'enclitic', False, 'FOC')], 'ku=gam=ar', 'DEM=fish=FOC'),
}


def _state(c, pid):
    ws = Workspace(c, load_project(c, pid))
    w = ws.doc(ws.documents()[0]['id']).sentences[0].words[0]
    return ws, w, [(m.id, m.form, m.morph_type, sorted((n, sp.id, sp.value, str(sp.metadata)) for n, sp in m.fields.items()))
                   for m in w.morphemes]


@pytest.mark.parametrize('case', sorted(WORDS))
def test_a_clitic_word_given_back_as_read_is_kept_on_the_core(live_client, case):
    morphs, seg, glosses = WORDS[case]
    s = seed(live_client, project(), {'d1': w1_doc(morphs, pos=[f'P{i}' for i in range(len(morphs))])},
             {VOCAB: lexicon_raw()}, name=f'rev-km live {case}')
    try:
        ws, w, before = _state(live_client, s.project_id)
        assert segmentation(w) == seg
        out = call_tool(ws, 'analyze_sentence', {'document': ws.documents()[0]['name'],
                                                 'sentences': [{'ref': 's1.w1', 'words': [f'{seg} {glosses}']}]})
        ops = ws.plan_payload()['ops'] if ws.ops else []
        assert all(o['kind'] == 'link' for o in ops), out
        if ops:
            execute_plan(live_client, ops, source='service:igt:job', label='t', stamp_mode='machine',
                         detail={'job': 'rev-km-live'})
        _ws, _w, after = _state(live_client, s.project_id)
        assert after == before
    finally:
        s.delete()
