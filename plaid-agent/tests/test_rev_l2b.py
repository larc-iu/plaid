"""REV-L2B's probes (scripts/REV-L2B/test_revl2b_probes.py) as tests, under
the in-place rule (KM, tools.in_place): a person's analysis given back as
read, or differing only by a link, is not rewritten; a change planned on a
morpheme stays beside a restatement; a take-back takes the entries only it
used; the answers say what was taken back."""

import pytest

from fixtures import FakeClient, fake_ws, lexicon_raw
from test_restated_analysis import ALIDI, doc, project

from plaid_agent.core import tools as core_tools
from plaid_agent.igt.toolkit import call_tool


def gam_doc():
    """Gam-ar (s2.w1): ar an enclitic by its type with no "=" typed, as a
    FLEx import leaves it, both morphemes glossed by a person."""
    raw = doc()
    morph = raw['text_layers'][0]['token_layers'][2]
    morph['span_layers'][0]['spans'] += [{'id': 'sp-m4a', 'value': 'fish', 'tokens': ['m-4a']},
                                         {'id': 'sp-m4b', 'value': 'FOC', 'tokens': ['m-4b']}]
    return raw


def only_erg():
    lex = lexicon_raw()
    lex['items'] = [it for it in lex['items'] if it['id'] == 'vi-erg']
    return lex


def ws(lex=None, d=None):
    return fake_ws(FakeClient(project=project(), documents={'d1': d or gam_doc()}, lexicon=lex or lexicon_raw()))


def kinds(w):
    return [(o['kind'], o.get('word_id') or o.get('token_id') or o.get('form')) for o in w.ops]


# --- REV-L2B-1: a clitic by its type -----------------------------------------------------------


def test_l2b_1_a_clitic_by_its_type_given_back_as_read_stages_nothing():
    from plaid_agent.igt.project import segmentation
    w = ws(only_erg())
    assert segmentation(w.doc('d1').sentences[1].words[0]) == 'Gam=ar'
    out = call_tool(w, 'analyze_sentence', {'document': 'd1', 'sentences': [{'ref': 's2', 'words': ['Gam=ar fish=FOC']}]})
    assert w.ops == [], out
    w = ws(only_erg())
    out = call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's2.w1', 'morphemes': [
        {'form': 'Gam', 'fields': {'Morph Gloss': 'fish'}},
        {'form': 'ar', 'equals': True, 'fields': {'Morph Gloss': 'FOC'}}]})
    assert w.ops == [] and out.startswith('Nothing to change'), out


# --- REV-L2B-2: a link only --------------------------------------------------------------------


def test_l2b_2_an_unlinked_morpheme_one_entry_fits_gets_the_link_alone():
    w = ws()
    out = call_tool(w, 'analyze_sentence', {'document': 'd1', 'sentences': [{'ref': 's1.w1', 'words': ['Ali-di Ali-ERG']}]})
    assert [(o['kind'], o['token_id'], o['item_id']) for o in w.ops] == [('link', 'm-1a', 'vi-ali')], out


def test_l2b_2_a_homonym_a_person_linked_is_kept_when_another_fits():
    """gam glossed fish, linked by a person to gam 'net': gam 'fish' fits,
    and the call names no entry, so the person's link stays."""
    d = gam_doc()
    morph = d['text_layers'][0]['token_layers'][2]
    morph['span_layers'][0]['spans'].append({'id': 'sp-m2', 'value': 'fish', 'tokens': ['m-2']})
    morph['vocabs'][0]['vocab_links'].append({'id': 'l-3', 'vocab_item': {'id': 'vi-gam2', 'form': 'gam'},
                                              'tokens': ['m-2']})
    w = ws(d=d)
    out = call_tool(w, 'analyze_sentence', {'document': 'd1', 'sentences': [{'ref': 's1.w2', 'words': ['gam fish']}]})
    assert w.ops == [], out
    assert 'Nothing to change in w2' in out, out


def test_l2b_2_new_entries_on_an_unlinked_morpheme_creates_and_links_alone():
    w = ws(only_erg())
    out = call_tool(w, 'analyze_sentence', {'document': 'd1', 'new_entries': True, 'sentences': [
        {'ref': 's1.w1', 'words': ['Ali-di Ali-ERG']}]})
    assert sorted(k for k, _ in kinds(w)) == ['create_entry', 'link'], out
    assert [o['token_id'] for o in w.ops if o['kind'] == 'link'] == ['m-1a']


# --- REV-L2B-3: a planned change, then the word given back -------------------------------------


def test_l2b_3_a_planned_value_stays_beside_a_restatement():
    w = ws(only_erg())
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w1.m2'], 'field': 'POS', 'value': 'SUF'})
    out = call_tool(w, 'analyze_sentence', {'document': 'd1', 'sentences': [{'ref': 's1.w1', 'words': ['Ali-di Ali-ERG']}]})
    assert [(o['kind'], o['token_id'], o['value']) for o in w.ops] == [('set_span', 'm-1b', 'SUF')], out


# --- REV-L2B-4: the description ----------------------------------------------------------------


def test_l2b_4_set_analysis_says_what_it_keeps():
    from plaid_agent.igt.toolkit import TOOLS
    spec = next(t['function'] for t in TOOLS if t['function']['name'] == 'set_analysis')
    assert 'only the values given that differ are written, and every other value and link stays' \
        in spec['description']
    w = ws()
    out = call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': [{'form': 'Ali'}, {'form': 'di'}]})
    assert w.ops == [] and out.startswith('Nothing to change'), out


# --- REV-L2B-5: entries a taken-back analysis made ---------------------------------------------


def test_l2b_5_a_taken_back_analysis_takes_the_entries_only_it_used():
    w = ws(only_erg())
    call_tool(w, 'analyze_sentence', {'document': 'd1', 'new_entries': True, 'sentences': [
        {'ref': 's1.w1', 'words': ['Al-idi Ali-GEN']}]})
    assert sorted(k for k, _ in kinds(w)).count('create_entry') == 2, kinds(w)
    out = call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': ALIDI})
    assert w.ops == [] and not w.new_entries, kinds(w)
    assert 'The planned entries "Al", "idi" were taken out with them.' in out, out


def test_l2b_5_an_entry_the_plan_still_uses_stays():
    w = ws(only_erg())
    call_tool(w, 'analyze_sentence', {'document': 'd1', 'new_entries': True, 'sentences': [
        {'ref': 's1.w1', 'words': ['Al-idi Ali-GEN']}]})
    key = next(o['key'] for o in w.ops if o['kind'] == 'create_entry' and o['form'] == 'Al')
    call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s1.w3'], 'entry_id': key})
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': ALIDI})
    assert [o['form'] for o in w.ops if o['kind'] == 'create_entry'] == ['Al']


# --- S5 ----------------------------------------------------------------------------------------


def test_l2b_6_analyze_sentence_says_it_took_back_a_planned_analysis():
    w = ws(only_erg())
    call_tool(w, 'analyze_sentence', {'document': 'd1', 'sentences': [{'ref': 's1.w1', 'words': ['Al-idi Ali-GEN']}]})
    out = call_tool(w, 'analyze_sentence', {'document': 'd1', 'sentences': [{'ref': 's1.w1', 'words': ['Ali-di Ali-ERG']}]})
    assert w.ops == [] and 'Took back the planned change to w1.' in out, out


def test_l2b_7_set_analysis_for_form_refused_puts_its_take_backs_back(monkeypatch):
    w = ws()
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': [{'form': 'Alidi'}]})
    before = kinds(w)

    def refuse(self, ops):
        raise core_tools.ToolError('The plan is full.', kind='too-large')
    monkeypatch.setattr(type(w), 'add_ops', refuse)
    out = call_tool(w, 'set_analysis_for_form', {'form': 'Ali-di', 'morphemes': ALIDI})
    assert 'The plan is full.' in out and kinds(w) == before, (out, kinds(w))


@pytest.mark.parametrize('unattended', [False, True])
def test_l2b_a_restatement_in_chat_names_confirm(unattended):
    w = ws()
    w.UNATTENDED = unattended
    out = call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': ALIDI})
    assert out.startswith('Nothing to change') and ('confirm verifies what it holds.' in out) is not unattended, out
