"""Every inference about roles comes from configuration: a project with no
morpheme layer, fields not called Gloss (the gloss-like one not first), one
lexicon with a schema naming its fields "meaning"/"category" and one with none."""
from fixtures import scan_ws, odd_client

from plaid_igt_agent.project import load_project, render_document
from plaid_igt_agent.tools import Workspace, call_tool, TOOLS


def ws():
    c = odd_client()
    return scan_ws(c)


def test_gloss_roles_come_from_names_and_schemas():
    w = ws()
    p = w.project
    assert p.morpheme_layer_id is None and [f.name for f in p.fields_by_scope('Word')] == ['Category', 'Meaning']
    assert p.gloss_field('Word').name == 'Meaning' and p.gloss_field('Morpheme') is None
    assert p.gloss_field('Sentence').name == 'Free translation'  # the only one: first
    wl, plain = p.vocab('Wordlist'), p.vocab('Plain')
    assert (p.lexicon_field(wl, 'gloss'), p.lexicon_field(wl, 'pos')) == ('meaning', 'category')
    assert (p.lexicon_field(plain, 'gloss'), p.lexicon_field(plain, 'pos')) == ('gloss', 'pos')  # no schema: convention
    assert p.lexicon_field({'fields': ['note']}, 'gloss') is None


def test_tools_follow_the_configured_shape():
    w = ws()
    out = call_tool(w, 'worklist', {'kind': 'unglossed'})
    assert 'words without a Meaning value' in out and 's1.w3' in out and 's2.w1' in out
    out = call_tool(w, 'corpus_stats', {'by': 'document'})
    head = out.splitlines()[0]
    assert 'Meaning' in head and 'Free translation' in head and 'Category' not in head
    out = call_tool(w, 'check_lexicon', {})
    assert 'entries without a gloss/meaning' in out and 'Ali' in out.split('entries without a gloss/meaning')[1].split('\n\n')[0]
    assert 'entries without a category/pos' in out
    assert '2 homograph groups' not in out and '1 homograph groups (1 with a repeated gloss' in out  # both "gam" mean net
    out = call_tool(w, 'check_lexicon', {'section': 'glosses'})
    assert 'gam: lexicon "net", corpus mostly "fish"' in out
    out = call_tool(w, 'check_consistency', {'field': 'Meaning'})
    assert 'Error' not in out
    doc = render_document(w.doc('d1'), w.project)
    assert 'w1 Ali-di | Category=N | Meaning=Ali.ERG' in doc and 'Free translation: Ali saw a fish.' in doc
    ov = call_tool(w, 'project_overview', {})
    assert 'No morpheme layer' in ov and 'Treated as the gloss where a tool takes no field= (word: Meaning, sentence: Free translation)' in ov
    assert 'no morpheme layer' in call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': [{'form': 'a'}]}).lower()
    out = call_tool(w, 'set_entry_field', {'entry_form': 'Ali', 'field': 'Meaning', 'value': 'Ali'})
    assert 'Planned 1 change' in out and w.ops[-1]['field'] == 'meaning'  # schema names are matched case-insensitively
    assert 'has no entry field "gloss"' in call_tool(w, 'set_entry_field', {'entry_form': 'Ali', 'field': 'gloss', 'value': 'x'})
    call_tool(w, 'set_entry_field', {'entry_form': 'akuna', 'field': 'anything', 'value': 'x'})  # schema-less lexicon: any field
    assert w.ops[-1]['field'] == 'anything'


def test_every_read_tool_runs_on_the_odd_shape():
    """No tool may crash on a project without a morpheme layer or with unusual names."""
    w = ws()
    args = {'read_document': {'document': 'd1'}, 'search': {'pattern': 'gam'}, 'concordance': {'pattern': 'gam', 'where': 'baseline'},
            'analyses_of': {'form': 'gam'}, 'lexicon_entry': {'entry_form': 'Ali'}, 'check_consistency': {'field': 'Category'},
            'recent_changes': {}, 'frequency_list': {'what': 'Meaning'}, 'worklist': {'kind': 'unlinked'},
            'check_integrity': {}, 'sequence_search': {'sequence': [{'Category': 'N'}]}, 'corpus_stats': {}, 'read_lexicon': {},
            'query_help': {}, 'plan_status': {}, 'project_overview': {}}
    for name, a in args.items():
        out = call_tool(w, name, a)
        assert not out.startswith('Error: ') or 'no morpheme' in out.lower(), (name, out[:200])
