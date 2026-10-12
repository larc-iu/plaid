"""The corpus tools against a real server, the project read through the real API.

Each answer is checked against ``live_corpus_expected.json``: what the scan
path gave for the same call while igt still had one, a second implementation
that read the documents in Python and so made a reference the queries were
held to. A change that means to alter an answer rewrites the file: run this
module with ``PLAID_AGENT_WRITE_EXPECTED=1``, then read the diff.
"""
import json
import os
from pathlib import Path

import pytest
from fixtures import project_raw, document_raw, lexicon_raw, VOCAB
from live import live_client, seed  # noqa: F401 - fixture

from plaid_agent.igt.project import load_project, load_document
from plaid_agent.igt.workspace import Workspace
from plaid_agent.igt.toolkit import call_tool


EXPECTED_FILE = Path(__file__).with_name('live_corpus_expected.json')
EXPECTED = json.loads(EXPECTED_FILE.read_text())
WRITE = bool(os.environ.get('PLAID_AGENT_WRITE_EXPECTED'))


def teardown_module():
    if WRITE:
        EXPECTED_FILE.write_text(json.dumps(EXPECTED, indent=1, ensure_ascii=False, sort_keys=True) + '\n')


@pytest.fixture(scope='module')
def proj(live_client):
    s = seed(live_client, project_raw(), {'d1': document_raw()}, {VOCAB: lexicon_raw()})
    s.label = 'proj'
    yield s
    s.delete()


def workspace(proj):
    c = proj.client
    return Workspace(c, load_project(c, proj.project_id))


def expected(proj, tool, args, got):
    """What the call answered when the file was written (``got`` is stored
    instead, under PLAID_AGENT_WRITE_EXPECTED)."""
    key = f'{proj.label} {tool} {json.dumps(args, sort_keys=True, ensure_ascii=False)}'
    if WRITE:
        EXPECTED[key] = got
    assert key in EXPECTED, f'no expected answer for {key}: run with PLAID_AGENT_WRITE_EXPECTED=1'
    return EXPECTED[key]


def fixture_ids(proj, value):
    """``value`` with every id of the live project written as the fixture's."""
    text = json.dumps(value)
    for real, fixture in proj.ids.back.items():
        text = text.replace(real, fixture)
    return json.loads(text)


def test_seeded_project_parses_like_the_fixture(proj):
    c = proj.client
    p = load_project(c, proj.project_id)
    assert [f.name for f in p.fields.values()] == ['Translation', 'Gloss', 'Morph Gloss'] and p.orthographies == ['IPA']
    d = load_document(c, p, proj.ids['d1'])
    assert [w.surface for w in d.sentences[0].words] == ['Ali-di', 'gam', 'akuna']
    w1 = d.sentences[0].words[0]
    assert [(m.form, m.morph_type) for m in w1.morphemes] == [('Ali', None), ('di', 'suffix')]
    assert w1.link.form == 'Ali' and w1.morphemes[1].link.form == '-di' and w1.fields['Gloss'].value == 'Ali'
    assert d.sentences[0].fields['Translation'].value == 'Ali saw a fish.'
    # a raw query works and is scoped to this project
    r = c.query({'find': ['?t'], 'where': [['token', '?t', {'layer': p.word_layer_id}]], 'return': 'count',
                 'scope': {'project_ids': [p.id]}})
    assert r['count'] == 6


def same(proj, tool, args, normalize=lambda s: s):
    """The tool's answer, against the expected one, both in the fixture's
    ids. Returns the answer.

    Agreement alone is not enough: `call_tool` turns every failure into the
    string "Error: ...", so an answer is first held to being one."""
    out = fixture_ids(proj, call_tool(workspace(proj), tool, args))
    assert not out.startswith('Error:'), f'{tool} {args} failed: {out}'
    assert out.strip(), f'{tool} {args} answered nothing'
    want = expected(proj, tool, args, out)
    assert normalize(out) == normalize(want), f'{tool} {args}\n--- expected ---\n{want}\n--- answered ---\n{out}'
    return out


def test_search(proj):
    for args in ({'pattern': 'gam'}, {'pattern': 'a', 'where': 'morpheme'}, {'pattern': 'ERG', 'where': 'Morph Gloss'},
                 {'pattern': 'fish', 'where': 'Translation'}, {'pattern': 'nothing-here'},
                 {'pattern': '^gam-', 'regex': True}, {'pattern': 'ali', 'where': 'Gloss'},
                 {'pattern': 'gam', 'where': 'lexicon'}):
        same(proj, 'search', args)
    out = same(proj, 'search', {'pattern': 'gam'})
    assert out.startswith('2 hits:') and 's1.w2 gam || Ali-di gam akuna.' in out
    # A morpheme search counts the words it hits and, apart, the morphemes:
    # "N hits" was read as N morphemes where a word held two.
    out = same(proj, 'search', {'pattern': '.*', 'regex': True, 'where': 'morpheme'})
    assert out.startswith('3 words hit, holding 5 matching morphemes:'), out
    out = same(proj, 'search', {'pattern': '.', 'regex': True, 'where': 'Morph Gloss'})
    assert out.startswith('1 word hit, holding 2 matching morphemes:'), out


def strip_examples(text):
    """worklist lines without the examples column (references in the expected answers, which the
    scan path gave, document names now)."""
    return '\n'.join(line.rsplit('\t', 1)[0] if line.startswith('  ') else line for line in text.splitlines())


def no_longest(text):
    return '\n'.join(l for l in text.splitlines() if not l.startswith('  Longest words'))


def test_frequency_worklist_and_stats(proj):
    for args in ({}, {'what': 'morpheme'}, {'what': 'Morph Gloss'}, {'what': 'Gloss'}, {'what': 'Translation'},
                 {'limit': 2}, {'min_count': 2}):
        same(proj, 'frequency_list', args)
    for args in ({'kind': 'unglossed'}, {'kind': 'unglossed', 'field': 'Gloss'}, {'kind': 'unglossed', 'field': 'Translation'},
                 {'kind': 'unlinked'}, {'kind': 'unlinked', 'level': 'word'}, {'kind': 'unanalyzed'}, {'kind': 'unverified'}):
        same(proj, 'worklist', args, strip_examples)
    out = same(proj, 'corpus_stats', {}, no_longest)
    assert '1 document, 2 sentences, 4 words (4 distinct forms, 4 hapax' in out
    same(proj, 'corpus_stats', {'by': 'document'})
    same(proj, 'corpus_stats', {'by': 'Date'}, no_longest)


def test_concordance_analyses_and_consistency(proj):
    for args in ({'pattern': 'gam'}, {'pattern': 'a', 'regex': True}, {'pattern': 'ali-di', 'where': 'baseline'},
                 {'pattern': 'ERG', 'where': 'Morph Gloss'}, {'pattern': 'ali', 'where': 'Gloss'}, {'pattern': 'zzz'}):
        same(proj, 'concordance', args)
    for args in ({'field': 'Morph Gloss'}, {'field': 'Gloss'}, {'field': 'Translation'}):
        same(proj, 'check_consistency', args)
    b = workspace(proj)
    out = call_tool(b, 'analyses_of', {'form': 'gam'})
    assert 'Word "gam": 1 occurrence.' in out and 'Segmentation by slot: m1: gam (1)' in out
    assert 'Morpheme "gam": 2 occurrences.' in out and 'In words: gam (1), gam-ar (1)' in out
    assert 'Slot: m1 (2)' in out and '    s1.w2 gam' in out
    out = call_tool(b, 'analyses_of', {'form': 'di'})
    assert 'Word "di": no occurrences.' in out and 'Morph Gloss: ERG (1)' in out and 'Type: suffix (1)' in out and 'Links: -di (1)' in out


def test_lexicon_sequence_and_entry(proj):
    for args in ({}, {'section': 'unused'}, {'section': 'glosses'}, {'section': 'stale'}, {'section': 'homographs'}):
        same(proj, 'check_lexicon', args)
    for args in ({'sequence': [{'Gloss': 'Ali'}, {'form': 'gam'}]}, {'sequence': [{'Morph Gloss': 'ERG'}, {'form': 'akuna'}], 'adjacent': False},
                 {'sequence': [{'form': 'gam'}]}, {'sequence': [{'morpheme': 'ar'}]}, {'sequence': [{'type': 'suffix'}, {'form': 'gam'}]},
                 {'sequence': [{'form': 'gam'}, {'form': 'akuna'}]}, {'sequence': [{'form': 'ali-di'}, {'form': 'akuna'}]},
                 {'sequence': [{'form': '^g'}], 'regex': True}):
        same(proj, 'sequence_search', args)
    for args in ({'entry_form': 'Ali'}, {'entry_form': '-di'}, {'entry_form': 'gam', 'entry_gloss': 'fish'}):
        same(proj, 'lexicon_entry', args)


def comparable(ops):
    """A rule's digest of what it matched hashes the live project's own ids,
    so its count in each document is compared and the digest is not."""
    return [{**op, 'matched': [m[:2] for m in op['matched']]} if 'matched' in op else op for op in ops]


def same_ops(proj, tool, args):
    """The expected operations (labels included) and the expected answer.
    Returns the workspace."""
    b = workspace(proj)
    out = fixture_ids(proj, call_tool(b, tool, args))
    planned = fixture_ids(proj, [{k: v for k, v in op.items() if k != 'doc'} for op in b.ops])
    want = expected(proj, tool, args, {'answer': out, 'ops': comparable(planned)})
    assert comparable(planned) == comparable(want['ops']), \
        f'{tool} {args}\n--- expected ---\n{want["ops"]}\n--- planned ---\n{planned}'
    assert out == want['answer'], f'{tool} {args}\n--- expected ---\n{want["answer"]}\n--- answered ---\n{out}'
    return b


def test_bulk_tools_plan(proj):
    same_ops(proj, 'replace_in_field', {'field': 'Morph Gloss', 'pattern': 'ERG', 'replacement': 'OBL', 'whole': True})
    same_ops(proj, 'replace_in_field', {'field': 'Translation', 'pattern': r'(\w+)\.$', 'replacement': r'\1!', 'regex': True})
    same_ops(proj, 'replace_in_field', {'field': 'Gloss', 'pattern': 'zzz', 'replacement': 'y'})
    same_ops(proj, 'respell_all', {'pattern': 'a', 'replacement': 'ä'})
    same_ops(proj, 'respell_all', {'pattern': 'a', 'replacement': 'ä', 'case_sensitive': True, 'morpheme_forms': False, 'lexicon': False})
    same_ops(proj, 'copy_to_orthography', {'orthography': 'IPA'})
    same_ops(proj, 'copy_to_orthography', {'orthography': 'IPA', 'overwrite': True})
    same_ops(proj, 'set_field_for_form', {'form': 'gam', 'field': 'Gloss', 'value': 'fish'})
    same_ops(proj, 'set_field_for_form', {'form': 'ali', 'field': 'Gloss', 'value': 'Ali2', 'only_empty': False})
    same_ops(proj, 'set_field_for_form', {'form': 'di', 'field': 'Morph Gloss', 'value': 'OBL', 'only_empty': False})
    # akuna has no morpheme token: the rule reaches its derived morpheme.
    b = same_ops(proj, 'set_field_for_form', {'form': 'akuna', 'field': 'Morph Gloss', 'value': 'go'})
    from plaid_agent.igt.bulk import planned_changes
    assert [op['token_id'] for op in planned_changes(b)] == [f'virtual:{proj.ids["w-3"]}']
    same_ops(proj, 'set_analysis_for_form', {'form': 'GAM', 'morphemes': [{'form': 'gam', 'fields': {'Morph Gloss': 'fish'}}]})
    same_ops(proj, 'set_analysis_for_form', {'form': 'gam', 'morphemes': [{'form': 'gam'}], 'skip_analyzed': True})
    same_ops(proj, 'set_analysis_for_form', {'form': 'Ali-di', 'morphemes': [{'form': 'Ali'}, {'form': 'di', 'type': 'suffix', 'fields': {'Morph Gloss': 'ERG'}}]})
    b = same_ops(proj, 'merge_entries', {'keep_form': 'Ali', 'remove_form': '-di'})
    assert b.ops[-1]['links'] and b.ops[-1]['links'][0]['token_ids'] == [proj.ids['m-1b']]
    same_ops(proj, 'delete_entry', {'entry_form': 'Ali'})
    # The stale check knows the documents of query-built ops.
    assert [d['id'] for d in b.plan_payload()['documents']] == [proj.ids['d1']]


@pytest.fixture(scope='module')
def review_proj(live_client):
    """The fixture project with a machine-made multi-word expression over
    s1.w2 + s1.w3 and a contributed Gloss on s1.w1, for the tools that see
    links shared by several words and work awaiting review."""
    from fixtures_ext import mwe_document_raw, mwe_lexicon_raw, ANN
    raw = mwe_document_raw()
    layers = raw['text_layers'][0]['token_layers']
    layers[1]['vocabs'][0]['vocab_links'][1]['metadata'] = {'prov': 'inferred', 'provSource': 'service:mwe'}
    layers[1]['span_layers'][0]['spans'][0]['metadata'] = {'prov': 'contributed', 'provSource': f'user:{ANN}'}
    # A second expression over the same words whose entry no longer reads like them: stale.
    layers[1]['vocabs'][0]['vocab_links'].append(
        {'id': 'l-stale', 'vocab_item': {'id': 'vi-stale', 'form': 'zzz yyy'}, 'tokens': ['w-2', 'w-3']})
    lex = mwe_lexicon_raw()
    lex['items'].append({'id': 'vi-stale', 'form': 'zzz yyy', 'metadata': {'morphType': 'phrase'}})
    s = seed(live_client, project_raw(), {'d1': raw}, {VOCAB: lex}, name='igt-agent review test')
    s.label = 'review'
    yield s
    s.delete()


def test_multi_word_expressions_and_review(review_proj):
    from fixtures_ext import ANN
    proj = review_proj
    c = proj.client
    d = load_document(c, load_project(c, proj.project_id), proj.ids['d1'])
    w2, w3 = d.sentences[0].words[1], d.sentences[0].words[2]
    assert w2.link is None and len(w2.mwes) == 2 and w3.mwes == w2.mwes
    assert all(l.tokens == [proj.ids['w-2'], proj.ids['w-3']] for l in w2.mwes)
    for args in ({'pattern': 'gam'}, {'pattern': 'akuna'}):
        out = same(proj, 'search', args)
        assert 'mwe=gam akuna~ (w2+w3)' in out
    for args in ({}, {'section': 'stale'}, {'section': 'unused'}):
        same(proj, 'check_lexicon', args)
    out = same(proj, 'check_lexicon', {'section': 'stale'})
    assert '1 links whose form no longer contains the entry form: gam akuna → "zzz yyy"' in out
    assert 'Linked from 2 words and 0 morphemes (1 multi-word expression)' in same(proj, 'lexicon_entry', {'entry_form': 'gam akuna'})
    for args in ({'kind': 'unlinked', 'level': 'word'}, {'kind': 'unverified'}, {'kind': 'contributed'},
                 {'kind': 'contributed', 'user': ANN}, {'kind': 'contributed', 'user': 'nobody@x.com'}):
        same(proj, 'worklist', args, strip_examples)
    # The machine-made expression's words await review (the query reaches
    # link provenance through the link entity).
    out = same(proj, 'worklist', {'kind': 'unverified'}, strip_examples)
    assert '\tgam\t' in out and '\takuna\t' in out and '\tali-di\t' in out
    for args in ({'field': 'Gloss'}, {'field': 'Morph Gloss'}):
        same(proj, 'check_consistency', args)
    b = same_ops(proj, 'merge_entries', {'keep_form': 'Ali', 'remove_form': 'gam akuna'})
    assert b.ops[-1]['links'] == [{'link_id': proj.ids['l-mwe'], 'token_ids': [proj.ids['w-2'], proj.ids['w-3']]}]
    same_ops(proj, 'delete_entry', {'entry_form': 'gam akuna'})
    # A project-wide confirm finds the document by query and reads it for its links.
    b = same_ops(proj, 'confirm', {'documents': ['all']})
    assert b.ops[-1]['link_ids'] == [proj.ids['l-mwe']] and b.ops[-1]['span_ids'] == [proj.ids['sp-g1']]
    assert [d['id'] for d in b.plan_payload()['documents']] == [proj.ids['d1']]


def test_a_value_on_an_unsegmented_words_morpheme_is_written_with_the_morpheme(live_client):
    """Applied against the real core: the morpheme the editor derives is made
    at the word's extent, first in its chain, with the gloss on it, in one
    batch the core's morpheme-layer rules accept."""
    from plaid_agent.igt.plan import execute_plan
    # A project of its own: the module's is read by every other test here,
    # and `seed` replaces a project of the same name.
    s = seed(live_client, project_raw(), {'d1': document_raw()}, {VOCAB: lexicon_raw()},
             name='igt-agent test, derived morpheme')
    try:
        c = s.client
        p = load_project(c, s.project_id)
        w = Workspace(c, p)
        out = call_tool(w, 'set_field_for_form', {'form': 'akuna', 'field': 'Morph Gloss', 'value': 'go'})
        assert 'Planned 1 value in 1 document' in out, out
        execute_plan(c, w.plan_payload()['ops'], source='service:igt:assist:x', label='l', project=p)
        d = load_document(c, p, s.ids['d1'])
        [m] = d.sentences[0].words[2].morphemes
        assert not m.virtual and m.index == 1 and m.form == 'akuna' and m.fields['Morph Gloss'].value == 'go'
        assert m.metadata.get('provConfirmed') is True
        out = call_tool(Workspace(c, p), 'worklist', {'kind': 'unglossed'})
        assert 'akuna' not in out
    finally:
        s.delete()


def test_sequence_search_reads_a_shared_name_as_either_field(live_client):
    """A bare "Gloss" on words and on morphemes is either, on the real engine
    as on the fake, after the tool's own example was refused as ambiguous
    (2026-10-12 survey)."""
    import copy
    p = copy.deepcopy(project_raw())
    p['text_layers'][0]['token_layers'][2]['span_layers'][0]['name'] = 'Gloss'
    s = seed(live_client, p, {'d1': document_raw()}, {VOCAB: lexicon_raw()}, name='igt-agent shared gloss')
    try:
        w = Workspace(s.client, load_project(s.client, s.project_id))
        for value in ('ERG', 'Ali'):
            out = call_tool(w, 'sequence_search', {'sequence': [{'Gloss': value}, {'form': 'gam'}]})
            assert out.startswith('1 sentence match:\n("Gloss" names a word field and a morpheme field'), out
            assert 's1 [Ali-di] [gam] akuna' in out, out
    finally:
        s.delete()
