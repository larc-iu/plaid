"""REV-KM's probes (scripts/REV-KM/test_revkm_probes.py) as tests: a
proclitic or a mid-word clitic given back as read keeps the word, a type the
call gives is still compared, a link a first call planned goes when a later
call changes its gloss, a job's in-place value is not people's precedent, a
kept link whose entry no longer fits is said, set_analysis_for_form says what
it took back."""

import pytest

from fixtures import FakeClient, fake_ws, lexicon_raw
from test_restated_analysis import ALIDI, doc, project, ws

from plaid_agent.igt.project import segmentation
from plaid_agent.igt.toolkit import call_tool


def w1_doc(morphs, links=(), pos=None):
    """The fixture document with w-1 holding ``morphs``: [(id, form, type,
    equalsBefore, gloss)], a POS on each when ``pos`` is given."""
    raw = doc()
    ml = raw['text_layers'][0]['token_layers'][2]
    ml['tokens'] = [t for t in ml['tokens'] if t['id'] not in ('m-1a', 'm-1b')]
    gl = ml['span_layers'][0]
    gl['spans'] = [s for s in gl['spans'] if s['tokens'][0] not in ('m-1a', 'm-1b')]
    ml['span_layers'][-1]['spans'] = []
    for i, (mid, form, typ, eq, gloss) in enumerate(morphs, start=1):
        md = {'form': form, **({'morphType': typ} if typ else {}), **({'equalsBefore': True} if eq else {})}
        ml['tokens'].append({'id': mid, 'begin': 0, 'end': 6, 'precedence': i, 'metadata': md})
        gl['spans'].append({'id': f'sp-{mid}', 'value': gloss, 'tokens': [mid]})
        if pos:
            ml['span_layers'][-1]['spans'].append({'id': f'pos-{mid}', 'value': pos[i - 1], 'tokens': [mid]})
    ml['vocabs'][0]['vocab_links'] = [{'id': f'l-{mid}', 'vocab_item': {'id': item, 'form': ''}, 'tokens': [mid]}
                                      for mid, item in links]
    return raw


def mkws(raw, lex=None):
    return fake_ws(FakeClient(project=project(), documents={'d1': raw}, lexicon=lex or lexicon_raw()))


def brief(w):
    return [(o['kind'], o.get('token_id') or o.get('word_id'), o.get('value')) for o in w.ops]


def analyse(w, words):
    return call_tool(w, 'analyze_sentence', {'document': 'd1', 'sentences': [{'ref': 's1.w1', 'words': [words]}]})


# --- REV-KM-1: the joint, not the "=" rule's type --------------------------------------------


@pytest.mark.parametrize('m2type', [None, 'stem', 'root'])
def test_km_1_a_proclitic_given_back_as_read_keeps_the_word(m2type):
    raw = w1_doc([('ma', 'ku', 'proclitic', False, 'DEM'), ('mb', 'gam', m2type, False, 'fish')], pos=['D', 'N'])
    w = mkws(raw)
    seg = segmentation(w.doc('d1').sentences[0].words[0])
    assert seg == 'ku=gam'
    out = analyse(w, f'{seg} DEM=fish')
    # gam, unlinked, gets the one entry that fits: the link alone.
    assert [(o['kind'], o['token_id']) for o in w.ops] == [('link', 'mb')], out
    w = mkws(raw)
    analyse(w, f'{seg} DEM=FISH')
    assert brief(w) == [('set_span', 'mb', 'FISH')]
    w = mkws(raw)
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': [
        {'form': 'ku', 'fields': {'Morph Gloss': 'DEM'}}, {'form': 'gam', 'fields': {'Morph Gloss': 'FISH'}}]})
    assert brief(w) == [('set_span', 'mb', 'FISH')]


def test_km_1_a_clitic_in_the_middle_given_back_as_read_keeps_the_word():
    raw = w1_doc([('ma', 'Gam', None, False, 'fish'), ('mb', 'ar', 'enclitic', False, 'FOC'),
                  ('mc', 'i', 'suffix', False, 'PL')], pos=['N', 'X', 'Y'])
    w = mkws(raw)
    seg = segmentation(w.doc('d1').sentences[0].words[0])
    assert seg == 'Gam=ar=i'
    out = analyse(w, f'{seg} fish=FOC=PL')
    assert [k for k, *_ in brief(w)] in ([], ['link']), out
    assert not [o for o in w.ops if o['kind'] in ('set_analysis', 'set_span')]


@pytest.mark.parametrize('typ', [None, 'suffix'])
def test_km_1_a_typed_equals_before_a_morpheme_of_another_type_keeps_the_word(typ):
    raw = w1_doc([('ma', 'Ali', None, False, 'Ali'), ('mb', 'di', typ, True, 'ERG')], pos=['N', 'CASE'])
    w = mkws(raw)
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': [
        {'form': 'Ali', 'fields': {'Morph Gloss': 'Ali'}}, {'form': 'di', 'fields': {'Morph Gloss': 'GEN'}}]})
    assert brief(w) == [('set_span', 'mb', 'GEN')]
    w = mkws(raw)
    analyse(w, 'Ali=di Ali=ERG')
    assert not [o for o in w.ops if o['kind'] in ('set_analysis', 'set_span')], brief(w)


def test_km_1_a_type_the_call_gives_is_still_compared():
    raw = w1_doc([('ma', 'ku', 'proclitic', False, 'DEM'), ('mb', 'gam', None, False, 'fish')])
    w = mkws(raw)
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': [
        {'form': 'ku', 'fields': {'Morph Gloss': 'DEM'}}, {'form': 'gam', 'type': 'root', 'fields': {'Morph Gloss': 'fish'}}]})
    assert [o['kind'] for o in w.ops] == ['set_analysis']


# --- REV-KM-2: a link planned by an earlier call --------------------------------------------


def test_km_2_a_planned_link_goes_when_a_later_call_changes_the_gloss():
    w = ws()
    analyse(w, 'Ali-di Ali-ERG')
    assert [(o['kind'], o['token_id'], o['item_id']) for o in w.ops] == [('link', 'm-1a', 'vi-ali')]
    out = analyse(w, 'Ali-di PERSON-ERG')
    assert brief(w) == [('set_span', 'm-1a', 'PERSON')], out
    assert 'Took back the planned change to w1.' in out, out


def test_km_2_a_planned_link_stays_when_a_later_call_keeps_the_gloss():
    w = ws()
    analyse(w, 'Ali-di Ali-ERG')
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': ALIDI})
    assert [(o['kind'], o['token_id']) for o in w.ops] == [('link', 'm-1a')]


# --- REV-KM-3: people's precedent, per value ------------------------------------------------


def test_km_3_a_word_the_job_changed_in_place_is_no_ones_precedent():
    """w1 a person's ka-ta whose m2 gloss the job changed in place, w2 and
    w3 the job's own analyses. Harmonize sets the form by the job's own
    words, never "by: person"."""
    from job_fixtures import JobClient, document, recorded, runner, start
    J = 'JH'
    raw = document('d1', 'Story d1', [{'words': [('kata', [('ka', 'g1'), ('ta', 'G2')], J),
                                                 ('kata', [('ka', 'g1'), ('ta', 'G2')], J),
                                                 ('kata', [('ka', 'g1'), ('ta', 'g9')], J)]}])
    ml = next(tl for tl in raw['text_layers'][0]['token_layers'] if tl['id'] == 'tk-morph')
    for t in ml['tokens']:
        if t['id'].startswith('d1-s1w1'):
            t['metadata'] = {'form': t['metadata']['form']}
    for sp in ml['span_layers'][0]['spans']:
        if sp['tokens'] == ['d1-s1w1m1']:
            sp['metadata'] = {}
    client = JobClient({'d1': raw})
    job = start(client, id=J)
    job.update_row('d1', state='done')
    recorded(job)
    r = runner(job)
    out = r.harmonize(job)
    assert all(c['by'] != 'person' for c in out['changed']), out
    assert r.people.get('kata') in (None, {}), r.people


# --- REV-KM-4: a kept link its entry no longer fits ------------------------------------------


def test_km_4_a_kept_link_whose_entry_no_longer_fits_is_said():
    w = ws()
    out = analyse(w, 'Ali-di Ali-GEN')
    assert 's1.w1.m2 stays linked to' in out and '-di' in out.split('stays linked to')[1], out
    w = ws()
    out = call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': [
        ALIDI[0], {'form': 'di', 'fields': {'Morph Gloss': 'GEN'}}]})
    assert 's1.w1.m2 stays linked to' in out, out


def test_km_4_nothing_is_said_of_a_kept_link_that_still_fits():
    lex = lexicon_raw()
    lex['items'].append({'id': 'vi-di', 'form': 'di', 'metadata': {'gloss': 'GEN'}})
    raw = doc()
    raw['text_layers'][0]['token_layers'][2]['vocabs'][0]['vocab_links'][0]['vocab_item'] = {'id': 'vi-di', 'form': 'di'}
    w = mkws(raw, lex)
    out = analyse(w, 'Ali-di Ali-GEN')
    assert 'stays linked' not in out, out


# --- REV-KM-6 ---------------------------------------------------------------------------------


def test_km_6_set_analysis_for_form_says_it_took_back_a_planned_analysis():
    w = ws()
    call_tool(w, 'set_analysis_for_form', {'form': 'Ali-di', 'morphemes': [{'form': 'Alidi', 'fields': {'Morph Gloss': 'X'}}]})
    out = call_tool(w, 'set_analysis_for_form', {'form': 'Ali-di', 'morphemes': [
        ALIDI[0], {'form': 'di', 'fields': {'Morph Gloss': 'GEN'}}]})
    assert 'Took back the planned change of 1 occurrence.' in out, out
    assert [o['kind'] for o in w.ops] == ['set_span']
