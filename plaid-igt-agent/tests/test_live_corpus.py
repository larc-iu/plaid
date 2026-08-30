"""The query path against a real server, with the scan path as the oracle."""
import pytest
from fixtures import project_raw, document_raw, lexicon_raw, VOCAB
from live import live_client, seed  # noqa: F401 - fixture

from plaid_igt_agent.project import load_project, load_document
from plaid_igt_agent.tools import Workspace, call_tool


@pytest.fixture(scope='module')
def proj(live_client):
    s = seed(live_client, project_raw(), {'d1': document_raw()}, {VOCAB: lexicon_raw()})
    yield s
    s.delete()


def two(proj):
    """A scanning workspace and a querying one over the same live project."""
    c = proj.client
    p = load_project(c, proj.project_id)
    a, b = Workspace(c, p), Workspace(c, p)
    a.prefer_scan = True
    return a, b


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
    """Both paths, compared; the scan path is the oracle. Returns the query output."""
    a, b = two(proj)
    ra, rb = call_tool(a, tool, args), call_tool(b, tool, args)
    assert normalize(rb) == normalize(ra), f'{tool} {args}\n--- scan ---\n{ra}\n--- query ---\n{rb}'
    return rb


def test_search_matches_the_scan(proj):
    for args in ({'pattern': 'gam'}, {'pattern': 'a', 'where': 'morpheme'}, {'pattern': 'ERG', 'where': 'Morph Gloss'},
                 {'pattern': 'fish', 'where': 'Translation'}, {'pattern': 'nothing-here'},
                 {'pattern': '^gam-', 'regex': True}, {'pattern': 'ali', 'where': 'Gloss'},
                 {'pattern': 'gam', 'where': 'lexicon'}):
        same(proj, 'search', args)
    out = same(proj, 'search', {'pattern': 'gam'})
    assert out.startswith('2 hits:') and 's1.w2 gam || Ali-di gam akuna.' in out


def strip_examples(text):
    """worklist lines: drop the examples column (refs on the scan path, document names on the query path)."""
    return '\n'.join(line.rsplit('\t', 1)[0] if line.startswith('  ') else line for line in text.splitlines())


def no_longest(text):
    return '\n'.join(l for l in text.splitlines() if not l.startswith('  Longest words'))


def test_frequency_worklist_and_stats_match_the_scan(proj):
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
    _, b = two(proj)
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
                 {'sequence': [{'form': '^g', 'form2': 'x'}], 'regex': True} if False else {'sequence': [{'form': '^g'}], 'regex': True}):
        same(proj, 'sequence_search', args)
    for args in ({'entry_form': 'Ali'}, {'entry_form': '-di'}, {'entry_form': 'gam', 'entry_gloss': 'fish'}):
        same(proj, 'lexicon_entry', args)


def same_ops(proj, tool, args):
    """Both paths must plan the same operations (labels included); the query
    path also stamps each op with its document."""
    a, b = two(proj)
    ra, rb = call_tool(a, tool, args), call_tool(b, tool, args)
    strip = lambda ops: [{k: v for k, v in op.items() if k != 'doc'} for op in ops]  # noqa: E731
    assert strip(b.ops) == strip(a.ops), f'{tool} {args}\n--- scan ---\n{ra}\n{a.ops}\n--- query ---\n{rb}\n{b.ops}'
    assert rb == ra, f'{tool} {args}\n--- scan ---\n{ra}\n--- query ---\n{rb}'
    return b


def test_bulk_tools_plan_the_same_ops(proj):
    same_ops(proj, 'replace_in_field', {'field': 'Morph Gloss', 'pattern': 'ERG', 'replacement': 'OBL', 'whole_value': True})
    same_ops(proj, 'replace_in_field', {'field': 'Translation', 'pattern': r'(\w+)\.$', 'replacement': r'\1!', 'regex': True})
    same_ops(proj, 'replace_in_field', {'field': 'Gloss', 'pattern': 'zzz', 'replacement': 'y'})
    same_ops(proj, 'respell_all', {'pattern': 'a', 'replacement': 'ä'})
    same_ops(proj, 'respell_all', {'pattern': 'a', 'replacement': 'ä', 'case_sensitive': True, 'morpheme_forms': False, 'lexicon': False})
    same_ops(proj, 'copy_to_orthography', {'orthography': 'IPA'})
    same_ops(proj, 'copy_to_orthography', {'orthography': 'IPA', 'overwrite': True})
    same_ops(proj, 'set_field_for_form', {'form': 'gam', 'field': 'Gloss', 'value': 'fish'})
    same_ops(proj, 'set_field_for_form', {'form': 'ali', 'field': 'Gloss', 'value': 'Ali2', 'only_empty': False})
    same_ops(proj, 'set_field_for_form', {'form': 'di', 'field': 'Morph Gloss', 'value': 'OBL', 'only_empty': False})
    same_ops(proj, 'set_analysis_for_form', {'form': 'GAM', 'morphemes': [{'form': 'gam', 'fields': {'Morph Gloss': 'fish'}}]})
    same_ops(proj, 'set_analysis_for_form', {'form': 'gam', 'morphemes': [{'form': 'gam'}], 'skip_analyzed': True})
    same_ops(proj, 'set_analysis_for_form', {'form': 'Ali-di', 'morphemes': [{'form': 'Ali'}, {'form': 'di', 'type': 'suffix', 'fields': {'Morph Gloss': 'ERG'}}]})
    b = same_ops(proj, 'merge_entries', {'keep_form': 'Ali', 'remove_form': '-di'})
    assert b.ops[-1]['links'] and b.ops[-1]['links'][0]['token_id'] == proj.ids['m-1b']
    same_ops(proj, 'delete_entry', {'entry_form': 'Ali'})
    # The stale check knows the documents of query-built ops.
    assert [d['id'] for d in b.plan_payload()['documents']] == [proj.ids['d1']]
