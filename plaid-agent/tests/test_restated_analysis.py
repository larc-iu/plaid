"""An analysis that restates what the word holds stages nothing (REV-L2-1),
in every tool that stages a set_analysis: set_analysis, analyze_sentence,
set_analysis_for_form, and a job's piece through them. The rule is
set_field's "Nothing to change": the word's stored morphemes equal the given
ones in number, order, form and every value the call names, and the link the
call would make on each morpheme is the one it holds (or it makes none). Then
no op is made, and the word keeps its provenance, its links and the values
nobody named. Where a value or a link differs, only it is staged
(test_analysis_in_place, KM), and where the shape differs the analysis
replaces the chain as before."""

import copy

import pytest

from fixtures import FakeClient, MGLOSS, MORPH_LAYER, PID, VOCAB, document_raw, fake_ws, lexicon_raw, project_raw

from plaid_agent.igt.toolkit import call_tool

POS_LAYER = 'sl-mpos'


def project():
    """The fixture's project without the Leipzig tagset on the morpheme
    gloss, and with a second morpheme field, POS."""
    raw = project_raw()
    morph = raw['text_layers'][0]['token_layers'][2]
    morph['span_layers'][0]['config']['igt'].pop('tagset')
    morph['span_layers'].append({'id': POS_LAYER, 'name': 'POS', 'config': {'igt': {'scope': 'Morpheme'}}})
    return raw


def doc():
    """The fixture's document, Ali-di's morphemes holding a POS each."""
    raw = document_raw()
    morph = raw['text_layers'][0]['token_layers'][2]
    morph['span_layers'].append({'id': POS_LAYER, 'spans': [
        {'id': 'sp-p1a', 'value': 'N', 'tokens': ['m-1a']},
        {'id': 'sp-p1b', 'value': 'CASE', 'tokens': ['m-1b']}]})
    return raw


def ws(lex=None):
    return fake_ws(FakeClient(project=project(), documents={'d1': doc()}, lexicon=lex or lexicon_raw()))


ALIDI = [{'form': 'Ali', 'fields': {'Morph Gloss': 'Ali'}}, {'form': 'di', 'fields': {'Morph Gloss': 'ERG'}}]


def analyses(w):
    return [o for o in w.ops if o.get('kind') == 'set_analysis']


# --- set_analysis ------------------------------------------------------------------------------


@pytest.mark.parametrize('given', [
    ALIDI,
    # the type it goes by, named
    [ALIDI[0], {**ALIDI[1], 'type': 'suffix'}],
    # forms only
    [{'form': 'Ali'}, {'form': 'di'}],
    # every field named, POS too
    [{'form': 'Ali', 'fields': {'Morph Gloss': 'Ali', 'POS': 'N'}},
     {'form': 'di', 'fields': {'Morph Gloss': 'ERG', 'POS': 'CASE'}}],
], ids=['glosses', 'type', 'forms', 'every-field'])
def test_set_analysis_restating_the_word_stages_nothing(given):
    w = ws()
    out = call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': given})
    assert out.startswith('Nothing to change: s1.w1 already holds that analysis.'), out
    assert w.ops == []


@pytest.mark.parametrize('given', [
    [ALIDI[0], {**ALIDI[1], 'type': 'enclitic'}],
    [{'form': 'Ali', 'fields': {'Morph Gloss': 'Ali'}}, {'form': 'di', 'equals': True}],
    [{'form': 'Alidi', 'fields': {'Morph Gloss': 'Ali'}}],
    [{'form': 'Ali'}, {'form': 'd'}, {'form': 'i'}],
], ids=['type', 'equals', 'fewer', 'more'])
def test_set_analysis_that_changes_the_shape_is_staged(given):
    w = ws()
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': given})
    assert len(analyses(w)) == 1


@pytest.mark.parametrize('given', [
    [ALIDI[0], {'form': 'di', 'fields': {'Morph Gloss': 'GEN'}}],
    [ALIDI[0], {'form': 'di', 'fields': {'Morph Gloss': 'ERG', 'POS': ''}}],
], ids=['gloss', 'cleared'])
def test_set_analysis_that_changes_a_value_stages_the_value(given):
    w = ws()
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': given})
    assert [(o['kind'], o['token_id']) for o in w.ops] == [('set_span', 'm-1b')]


def test_an_unanalysed_word_given_its_surface_is_staged():
    """A word with no stored morpheme holds no analysis to restate."""
    w = ws()
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w3', 'morphemes': [{'form': 'akuna'}]})
    assert len(analyses(w)) == 1


def test_restating_after_a_planned_change_takes_it_back():
    w = ws()
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1',
                                  'morphemes': [ALIDI[0], {'form': 'di', 'fields': {'Morph Gloss': 'GEN'}}]})
    assert [o['kind'] for o in w.ops] == ['set_span']
    out = call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': ALIDI})
    assert out.startswith('Took back the planned change to the values of s1.w1'), out
    assert w.ops == []
    # A planned analysis of another shape is taken back the same way.
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': [{'form': 'Alidi'}]})
    assert len(analyses(w)) == 1
    out = call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': ALIDI})
    assert out.startswith('Took back the planned analysis of s1.w1'), out
    assert w.ops == []


def test_a_restatement_in_decomposed_letters_is_one():
    """Core stores text composed (NFC): a form given decomposed is the same."""
    raw = doc()
    raw['text_layers'][0]['text']['body'] = raw['text_layers'][0]['text']['body'].replace('Ali-di', 'Alé-di')
    raw['text_layers'][0]['token_layers'][2]['tokens'][0]['metadata']['form'] = 'Alé'
    w = fake_ws(FakeClient(project=project(), documents={'d1': raw}, lexicon=lexicon_raw()))
    out = call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': [
        {'form': 'Ale\u0301', 'fields': {'Morph Gloss': 'Ali'}}, ALIDI[1]]})
    assert out.startswith('Nothing to change'), out


# --- analyze_sentence --------------------------------------------------------------------------


def only_erg():
    """A lexicon whose one entry is the one Ali-di's second morpheme is linked to."""
    lex = lexicon_raw()
    lex['items'] = [it for it in lex['items'] if it['id'] == 'vi-erg']
    return lex


def test_analyze_sentence_restating_a_linked_word_stages_nothing():
    """Ali is unlinked and no entry fits it, di keeps the link it holds (no
    entry fits "di" by the fit rules, and a link on a morpheme kept stays)."""
    w = ws(only_erg())
    out = call_tool(w, 'analyze_sentence', {'document': 'd1', 'sentences': [
        {'ref': 's1.w1', 'words': ['Ali-di Ali-ERG']}]})
    assert w.ops == [], out
    assert 's1.w1: 0 words analysed, 0 links. Nothing to change in w1: it holds that analysis.' in out


def test_analyze_sentence_restating_beside_a_new_analysis_stages_only_the_new_one():
    """gam's one stored morpheme holds nothing of its own and akuna has
    none stored: both get an analysis, written whole (FX)."""
    w = ws(only_erg())
    call_tool(w, 'analyze_sentence', {'document': 'd1', 'sentences': [
        {'ref': 's1', 'words': ['Ali-di Ali-ERG', 'gam fish', 'aku-na see-PST']}]})
    assert [o['word_id'] for o in analyses(w)] == ['w-2', 'w-3']
    assert not any(o['kind'] == 'set_span' for o in w.ops)
    assert not any(o.get('kind') == 'link' and o.get('token_id') in ('m-1a', 'm-1b') for o in w.ops)


def test_analyze_sentence_where_another_entry_fits_keeps_the_link_held():
    """di 'ERG' fits another entry than the one it is linked to: the
    morpheme the word keeps keeps its link, which only a call naming an
    entry changes (KM, REV-L2B-2). Ali, unlinked, fits none."""
    lex = lexicon_raw()
    lex['items'] = [{'id': 'vi-erg2', 'form': 'di', 'metadata': {'gloss': 'ERG', 'morphType': 'suffix'}}]
    w = ws(lex)
    call_tool(w, 'analyze_sentence', {'document': 'd1', 'sentences': [{'ref': 's1.w1', 'words': ['Ali-di Ali-ERG']}]})
    assert w.ops == []


def test_analyze_sentence_that_would_create_an_entry_stages_it_and_its_links_alone():
    w = ws(only_erg())
    call_tool(w, 'analyze_sentence', {'document': 'd1', 'new_entries': True, 'sentences': [
        {'ref': 's1.w1', 'words': ['Ali-di Ali-ERG']}]})
    assert analyses(w) == []
    # Ali, unlinked: its entry made and linked. di keeps its link.
    assert sorted(o['kind'] for o in w.ops) == ['create_entry', 'link']
    assert [o.get('token_id') for o in w.ops if o['kind'] == 'link'] == ['m-1a']


# --- set_analysis_for_form ---------------------------------------------------------------------


def test_set_analysis_for_form_restating_stages_nothing():
    w = ws()
    out = call_tool(w, 'set_analysis_for_form', {'form': 'Ali-di', 'morphemes': ALIDI})
    assert out.startswith('Nothing to change: 1 occurrence of "Ali-di" already holds that analysis.'), out
    assert w.ops == []


def test_set_analysis_for_form_that_changes_a_gloss_stages_the_gloss():
    w = ws()
    call_tool(w, 'set_analysis_for_form', {'form': 'Ali-di', 'morphemes': [
        ALIDI[0], {'form': 'di', 'fields': {'Morph Gloss': 'GEN'}}]})
    assert [(o['kind'], o['token_id'], o['value']) for o in w.ops] == [('set_span', 'm-1b', 'GEN')]


# --- a job's walk ------------------------------------------------------------------------------
# The reviewer's probes (REV-L2 test_revl2_probes.py): a fully analysed text
# with no plan (the job then ends, REV-DF3-2) or a plan in sentences, and a
# piece that restates every analysis it reads.


J = 'JRS'
WORDS = [['ka', 'ta'], ['sa', 'mo']]


def _job(monkeypatch, sentences, restate, plan=None):
    from job_fixtures import JobClient, Model, document, job_project, keep_plan, start, use
    from plaid_agent.igt import job as igt_job
    client = JobClient({'d1': document('d1', 'Story', sentences)}, project=job_project())
    job = start(client, 'Segment and gloss the words nobody has analysed.', id=J, plan=None)
    if plan is not None:
        keep_plan(client, J, plan)
    sent = []
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        sent.extend(copy.deepcopy(ops))
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    use(monkeypatch, Model(restate))
    return job, sent


@pytest.mark.parametrize('plan', [None, 'sentences'])
def test_a_job_restating_peoples_analyses_writes_nothing(monkeypatch, plan):
    from job_fixtures import call, reply, runner
    from plaid_agent.core.job import run_job

    def restate(asked, n, kwargs):
        if 'Instructions from' not in asked:
            return reply('Done.')
        if n == 1 and 'Your piece: s' in asked:
            line = next(x for x in asked.splitlines() if x.startswith('Your piece: s'))
            refs = [int(r[1:]) for r in line[len('Your piece: '):].split('.')[0].split(', ')]
            return reply(calls=[call(1, 'analyze_sentence', {
                'document': 'Story',
                'sentences': [{'ref': f's{s}', 'words': [f'{w} g' for w in WORDS[s - 1]]} for s in refs]})])
        return reply('Checked the glosses, as people have them.')
    sentences = [{'words': [(w, [(w, 'g')], 'human') for w in ws_], 'translation': (f'T{i}.', 'human')}
                 for i, ws_ in enumerate(WORDS, start=1)]
    job, sent = _job(monkeypatch, sentences, restate, plan)
    finished = run_job(job, runner(job))
    assert sent == []
    t = finished['report']['totals']
    assert (t['changes'], t['words'], t['links'], t['repeated']) == (0, 0, 0, 0), t


def test_a_job_restating_a_linked_word_keeps_its_links(monkeypatch):
    from job_fixtures import call, reply, runner
    from plaid_agent.core.job import run_job

    def restate(asked, n, kwargs):
        if 'Instructions from' not in asked:
            return reply('Done.')
        if n == 1 and 'Your piece: s' in asked:
            return reply(calls=[call(1, 'analyze_sentence', {'document': 'Story', 'sentences': [
                {'ref': 's1', 'words': ['ka-ta g1-g2']}]})])
        return reply('Checked.')
    sentences = [{'words': [('kata', [('ka', 'g1', 'e1'), ('ta', 'g2', 'e2')], 'human')],
                  'translation': ('T.', 'human')}]
    job, sent = _job(monkeypatch, sentences, restate)
    run_job(job, runner(job))
    assert sent == []


# --- what the plan already holds ---------------------------------------------------------------


def test_a_restatement_after_a_value_planned_on_a_morpheme_takes_it_back():
    """The rule compares with what the word holds. A value planned on one
    of the word's morphemes that the analysis names as stored is taken back,
    set_field's rule (KM). A planned form or type makes the analysis whole
    (test_analysis_in_place)."""
    w = ws()
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w1.m1'], 'field': 'Morph Gloss', 'value': 'new'})
    out = call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': ALIDI})
    assert w.ops == [], out


def test_harmonize_names_every_field_the_word_holds_so_its_rewrite_is_whole():
    """Harmonize rewrites a word of the job's whole to the analysis chosen.
    A morpheme field the word holds and the chosen analysis does not is
    named empty, so the rewrite clears it, on the morphemes the word keeps
    (KM)."""
    from plaid_agent.igt.job import IgtRunner
    w = ws()
    d = w.doc('d1')
    s = d.sentences[0]
    to = {'morphemes': [{'form': 'Ali', 'fields': {'Morph Gloss': 'Ali'}},
                        {'form': 'di', 'type': 'suffix', 'fields': {'Morph Gloss': 'ERG'}}], 'word': {}}
    assert IgtRunner.stage(w, d, s, s.words[0], to) is None
    assert analyses(w) == []
    assert {(o['span_id'], o['value']) for o in w.ops if o['kind'] == 'set_span' and o['layer_id'] == POS_LAYER} \
        == {('sp-p1a', ''), ('sp-p1b', '')}
