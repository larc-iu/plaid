"""An analysis that keeps the word's morphemes changes only what differs (KM,
2026-11-14). THE rule (``tools.in_place``), compared by place: when the
morphemes given are as many as the word holds and each has the same form
(NFC), the same "=" before it and the type given if one is, no morpheme is
deleted or made. Each value the call names that differs is set on its
morpheme as set_field sets it, a value named empty is cleared, and every
value and link the call does not name stays with its provenance. A restating
call stages nothing (REV-L2-1). Any other shape replaces the chain, as
before. set_analysis, analyze_sentence, set_analysis_for_form and harmonize
all stage through it."""

import pytest

from fixtures import FakeClient, MGLOSS, fake_ws, lexicon_raw
from test_restated_analysis import ALIDI, POS_LAYER, analyses, doc, project, ws

from plaid_agent.igt.plan import execute_plan
from plaid_agent.igt.tools import ANALYSIS_OF
from plaid_agent.igt.toolkit import call_tool

GEN = [ALIDI[0], {'form': 'di', 'fields': {'Morph Gloss': 'GEN'}}]


def values(w):
    return [o for o in w.ops if o.get('kind') == 'set_span']


# --- set_analysis ------------------------------------------------------------------------------


def test_one_gloss_changed_is_one_value_on_the_morpheme_it_keeps():
    w = ws()
    out = call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': GEN})
    (op,) = w.ops
    assert (op['kind'], op['token_id'], op['span_id'], op['layer_id'], op['value']) == \
        ('set_span', 'm-1b', 'sp-m1b', MGLOSS, 'GEN')
    assert op[ANALYSIS_OF] == 'w-1'
    assert op['label'].endswith('s1.w1.m2 "di": Morph Gloss "ERG" → "GEN"'), op['label']
    assert out.startswith('Planned 1 change '), out
    assert out.endswith(' s1.w1.m2 "di": Morph Gloss "ERG" → "GEN".'), out


def test_a_field_named_empty_is_cleared_and_one_not_named_stays():
    w = ws()
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': [
        ALIDI[0], {'form': 'di', 'fields': {'Morph Gloss': 'ERG', 'POS': ''}}]})
    (op,) = w.ops
    assert (op['span_id'], op['value']) == ('sp-p1b', '')
    assert op['label'].endswith('POS "CASE" → "" (cleared)'), op['label']


def test_a_value_new_on_a_morpheme_is_made_on_it():
    w = ws()
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': [
        ALIDI[0], {'form': 'di', 'fields': {'Morph Gloss': 'ERG', 'POS': 'CASE'}}]})
    assert w.ops == []
    raw = doc()
    morph = raw['text_layers'][0]['token_layers'][2]
    morph['span_layers'][-1]['spans'] = [sp for sp in morph['span_layers'][-1]['spans'] if sp['id'] != 'sp-p1b']
    w = fake_ws(FakeClient(project=project(), documents={'d1': raw}, lexicon=lexicon_raw()))
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': [
        ALIDI[0], {'form': 'di', 'fields': {'POS': 'CASE'}}]})
    (op,) = w.ops
    assert (op['token_id'], op['span_id'], op['layer_id'], op['value']) == ('m-1b', None, POS_LAYER, 'CASE')
    assert op['label'].endswith('POS = "CASE"')


@pytest.mark.parametrize('given', [
    [ALIDI[0], {**GEN[1], 'type': 'enclitic'}],
    [ALIDI[0], {**GEN[1], 'equals': True}],
    [{'form': 'Ali', 'fields': {'Morph Gloss': 'Ali'}}, {'form': 'd', 'fields': {'Morph Gloss': 'GEN'}}],
    [{'form': 'Alidi', 'fields': {'Morph Gloss': 'Ali'}}],
    [{'form': 'Ali'}, {'form': 'd'}, {'form': 'i'}],
], ids=['type', 'equals', 'form', 'fewer', 'more'])
def test_another_shape_replaces_the_chain_as_before(given):
    w = ws()
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': given})
    assert [o['kind'] for o in w.ops] == ['set_analysis']


def test_two_calls_on_one_word_keep_both_changes():
    """The second call's value replaces nothing of the first: it names
    another morpheme's gloss, and the first's planned value stays."""
    w = ws()
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': GEN})
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': [
        {'form': 'Ali', 'fields': {'Morph Gloss': 'NAME'}}, {'form': 'di'}]})
    assert sorted((o['token_id'], o['value']) for o in w.ops) == [('m-1a', 'NAME'), ('m-1b', 'GEN')]


def test_a_value_named_as_stored_takes_back_the_planned_one():
    w = ws()
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': GEN})
    out = call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': ALIDI})
    assert w.ops == []
    assert out.startswith('Took back the planned change to the values of s1.w1'), out


def test_a_planned_chain_is_taken_back_for_the_analysis_the_word_keeps():
    w = ws()
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': [{'form': 'Alidi'}]})
    assert len(analyses(w)) == 1
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': GEN})
    assert [(o['kind'], o['token_id']) for o in w.ops] == [('set_span', 'm-1b')]


def test_a_planned_form_on_a_morpheme_makes_the_analysis_whole():
    """The plan changes the form of m2: the word no longer holds that shape
    once approved, so the analysis replaces the chain and supersedes it."""
    w = ws()
    call_tool(w, 'set_morpheme', {'document': 'd1', 'ref': 's1.w1.m2', 'form': 'de'})
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': GEN})
    assert [o['kind'] for o in w.ops] == ['set_analysis']


# --- applied -----------------------------------------------------------------------------------


@pytest.mark.parametrize('mode', ['verified', 'unverified', 'human'])
def test_approval_writes_only_the_value_that_changes(mode):
    client = FakeClient(project=project(), documents={'d1': doc()}, lexicon=lexicon_raw())
    w = fake_ws(client)
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': GEN})
    execute_plan(client, w.plan_payload()['ops'], source='service:igt:assist:fake', label='t', stamp_mode=mode)
    sent = [name for name, _p in client.calls if name.split('.')[0] in ('tokens', 'spans', 'vocab_links')]
    assert sent == ['spans.bulk_update'], sent
    (items,) = client.payloads('spans.bulk_update')
    (item,) = items
    assert (item['id'], item['value']) == ('sp-m1b', 'GEN'), item
    sets = {o['path'][0]: o.get('value') for o in item['metadata'] if o['op'] == 'set'}
    assert sets.get('provConfirmed') is ({'verified': True}.get(mode)), item
    assert ('prov' in sets) is (mode != 'human'), item


# --- analyze_sentence --------------------------------------------------------------------------


def alis():
    """A lexicon where Ali glossed Ali fits one entry, vi-ali, while the
    stored m1 is linked to another."""
    lex = lexicon_raw()
    lex['items'].append({'id': 'vi-ali2', 'form': 'Ali', 'metadata': {'gloss': 'name'}})
    return lex


def linked_doc():
    raw = doc()
    raw['text_layers'][0]['token_layers'][2]['vocabs'][0]['vocab_links'].append(
        {'id': 'l-1a', 'vocab_item': {'id': 'vi-ali2', 'form': 'Ali'}, 'tokens': ['m-1a']})
    return raw


def test_analyze_sentence_changing_only_a_link_stages_the_link_alone():
    w = fake_ws(FakeClient(project=project(), documents={'d1': linked_doc()}, lexicon=alis()))
    out = call_tool(w, 'analyze_sentence', {'document': 'd1', 'sentences': [{'ref': 's1.w1', 'words': ['Ali-di Ali-ERG']}]})
    (op,) = w.ops
    assert (op['kind'], op['token_id'], op['item_id'], op['existing_link_id']) == ('link', 'm-1a', 'vi-ali', 'l-1a')
    assert 's1.w1: 0 words analysed, 1 link.' in out, out
    # A morpheme it keeps that holds a link and fits no entry keeps it, unlisted.
    assert 's1.w1.m2' not in out, out


def test_analyze_sentence_changing_a_gloss_keeps_the_morphemes_and_their_links():
    w = fake_ws(FakeClient(project=project(), documents={'d1': linked_doc()}, lexicon=alis()))
    out = call_tool(w, 'analyze_sentence', {'document': 'd1', 'sentences': [{'ref': 's1.w1', 'words': ['Ali-di name-ERG']}]})
    (op,) = w.ops
    assert (op['kind'], op['token_id'], op['value']) == ('set_span', 'm-1a', 'name')
    assert 's1.w1: 1 word analysed, 0 links.' in out, out


def test_analyze_sentence_and_set_analysis_stage_the_same_values():
    a, b = ws(), ws()
    call_tool(a, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': GEN})
    call_tool(b, 'analyze_sentence', {'document': 'd1', 'sentences': [{'ref': 's1.w1', 'words': ['Ali-di Ali-GEN']}]})
    assert values(a) == values(b)


# --- set_analysis_for_form ---------------------------------------------------------------------


def test_set_analysis_for_form_changes_the_one_value_on_each_occurrence():
    w = ws()
    out = call_tool(w, 'set_analysis_for_form', {'form': 'Ali-di', 'morphemes': GEN})
    (op,) = w.ops
    assert (op['kind'], op['token_id'], op['span_id'], op['value'], op[ANALYSIS_OF], op['doc']) == \
        ('set_span', 'm-1b', 'sp-m1b', 'GEN', 'w-1', 'd1')
    assert 'Morph Gloss "ERG" → "GEN"' in op['label'], op['label']
    assert out.startswith('Planned 1 change '), out


# --- harmonize ---------------------------------------------------------------------------------


def test_harmonize_rewrites_a_kept_word_value_by_value_and_unlinks_what_the_target_does_not_link():
    """The target analysis has the word's shape: its glosses differ on m2, it
    names no POS (cleared) and links m2 to no entry (unlinked), m1's link
    stays as the target has it."""
    from plaid_agent.igt.job import IgtRunner
    raw = doc()
    raw['text_layers'][0]['token_layers'][2]['vocabs'][0]['vocab_links'].append(
        {'id': 'l-1a', 'vocab_item': {'id': 'vi-ali', 'form': 'Ali'}, 'tokens': ['m-1a']})
    w = fake_ws(FakeClient(project=project(), documents={'d1': raw}, lexicon=lexicon_raw()))
    d = w.doc('d1')
    s = d.sentences[0]
    to = {'morphemes': [{'form': 'Ali', 'fields': {'Morph Gloss': 'Ali'}, 'entry': 'vi-ali'},
                        {'form': 'di', 'type': 'suffix', 'fields': {'Morph Gloss': 'GEN'}}], 'word': {'Gloss': 'Ali'}}
    assert IgtRunner.stage(w, d, s, s.words[0], to) is None
    got = sorted((o['kind'], o.get('span_id') or o.get('link_id'), o.get('value')) for o in w.ops)
    assert got == [('set_span', 'sp-m1b', 'GEN'), ('set_span', 'sp-p1a', ''), ('set_span', 'sp-p1b', ''),
                   ('unlink', 'l-2', None)], got


# --- a job -------------------------------------------------------------------------------------


def test_a_job_changing_one_gloss_of_peoples_analyses_writes_that_gloss_alone(monkeypatch):
    """A piece gives every word as people have it but one gloss: the job
    sends that one value, on the morpheme the word keeps, and counts one
    change, one word analysed, no link, no field row, nothing repeated."""
    from job_fixtures import call, reply, runner
    from plaid_agent.core.job import run_job
    from test_restated_analysis import _job

    def piece(asked, n, kwargs):
        if 'Instructions from' not in asked:
            return reply('Done.')
        if n == 1 and 'Your piece: s' in asked:
            return reply(calls=[call(1, 'analyze_sentence', {'document': 'Story', 'sentences': [
                {'ref': 's1', 'words': ['ka-ta g1-G2', 'sa g3']}]})])
        return reply('Changed the gloss of ta.')
    sentences = [{'words': [('kata', [('ka', 'g1'), ('ta', 'g2')], 'human'), ('sa', [('sa', 'g3')], 'human')],
                  'translation': ('T.', 'human')}]
    job, sent = _job(monkeypatch, sentences, piece, 'sentences')
    finished = run_job(job, runner(job))
    assert [(o['kind'], o['value'], o.get(ANALYSIS_OF)) for o in sent] == [('set_span', 'G2', 'd1-s1w1')], sent
    t = finished['report']['totals']
    assert (t['changes'], t['words'], t['links'], t['repeated']) == (1, 1, 0, 0), t
    assert not t.get('fields'), t
