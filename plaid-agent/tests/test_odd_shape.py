"""Every inference about roles comes from configuration: a project with no
morpheme layer, fields not called Gloss (the gloss-like one not first), one
lexicon with a schema naming its fields "meaning"/"category" and one with none."""
from fixtures import fake_ws, odd_client

from plaid_agent.igt.project import render_document
from plaid_agent.igt.toolkit import call_tool


def ws():
    c = odd_client()
    return fake_ws(c)


def test_gloss_roles_come_from_stored_settings_never_names():
    w = ws()
    p = w.project
    assert p.morpheme_layer_id is None and [f.name for f in p.fields_by_scope('Word')] == ['Category', 'Meaning']
    # Meaning's Lexicon field holds the gloss role, so it is the gloss though Category comes first.
    assert p.gloss_field('Word').name == 'Meaning' and p.gloss_field('Morpheme') is None
    assert p.gloss_field('Sentence').name == 'Free translation'  # the only one: first
    wl, plain = p.vocab('Wordlist'), p.vocab('Plain')
    assert (p.lexicon_field(wl, 'gloss'), p.lexicon_field(wl, 'pos')) == ('meaning', 'category')
    assert (p.lexicon_field(plain, 'gloss'), p.lexicon_field(plain, 'pos')) == (None, None)  # no schema, no roles
    # A field named gloss without the role plays none. The core inventory
    # rides along on every vocabulary, so only declared fields count.
    assert p.lexicon_field({'fields': [{'name': 'gloss', 'declared': True, 'role': None}]}, 'gloss') is None
    assert p.lexicon_field({'fields': [{'name': 'gloss', 'declared': False, 'role': 'gloss'}]}, 'gloss') is None
    assert p.lexicon_field({'fields': [{'name': 'Sense', 'declared': True, 'role': 'gloss'}]}, 'gloss') == 'Sense'


def test_a_field_named_gloss_is_not_the_gloss_without_its_setting():
    from plaid_agent.igt.project import Field, IgtProject
    fields = {
        'Gloss': Field(name='Gloss', layer_id='a', scope='Morpheme', base_name='Gloss'),
        'Sense': Field(name='Sense', layer_id='b', scope='Morpheme', base_name='Sense', lexicon_field='gloss'),
    }
    p = IgtProject(id='p', name='p', text_layer_id='t', sentence_layer_id='s', word_layer_id='w',
                   morpheme_layer_id='m', fields=fields, orthographies=[], ignored_cfg=None,
                   vocabs=[], document_metadata=[])
    assert p.gloss_field('Morpheme').name == 'Sense'


def test_the_default_gloss_field_reads_the_gloss_role_and_a_cleared_role_is_none():
    from plaid_agent.igt.project import Field, IgtProject
    from plaid_agent.igt.vocab import normalize_vocab_fields
    # Notes comes first, so a default that finds no gloss role is Notes.
    fields = {
        'Notes': Field(name='Notes', layer_id='n', scope='Morpheme', base_name='Notes'),
        'Gloss': Field(name='Gloss', layer_id='a', scope='Morpheme', base_name='Gloss', lexicon_field='gloss'),
        'Meaning': Field(name='Meaning', layer_id='b', scope='Morpheme', base_name='Meaning',
                         lexicon_field='meaning'),
    }

    def default(vocab_fields):
        vocabs = ([{'id': 'v', 'name': 'L', 'fields': normalize_vocab_fields(vocab_fields)}]
                  if vocab_fields is not None else [])
        return IgtProject(id='p', name='p', text_layer_id='t', sentence_layer_id='s', word_layer_id='w',
                          morpheme_layer_id='m', fields=fields, orthographies=[], ignored_cfg=None,
                          vocabs=vocabs, document_metadata=[]).gloss_field('Morpheme').name
    # The vocabulary gives `meaning` the gloss role and declares `gloss` with none.
    assert default({'gloss': {}, 'meaning': {'role': 'gloss'}}) == 'Meaning'
    # Both declared with their roles cleared: no gloss anywhere, so no pairing decides.
    assert default({'gloss': {}, 'meaning': {}}) == 'Notes'
    # No vocabulary: the core key `gloss` holds the gloss role.
    assert default(None) == 'Gloss'


def test_tools_follow_the_configured_shape():
    w = ws()
    out = call_tool(w, 'worklist', {'kind': 'unglossed', 'document': 'Odd text'})
    assert 'words without a Meaning value' in out and 's1.w3' in out and 's2.w1' in out
    out = call_tool(w, 'corpus_stats', {'by': 'document'})
    head = out.splitlines()[0]
    assert 'Meaning' in head and 'Free translation' in head and 'Category' not in head
    out = call_tool(w, 'check_lexicon', {})
    # The schema-less lexicon has no gloss or part-of-speech field to check.
    assert 'entries without a meaning' in out and 'Ali' in out.split('entries without a meaning')[1].split('\n\n')[0]
    assert 'entries without a category' in out
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
    # gloss and morphType are guaranteed on every vocabulary (the app injects
    # them and its entry editor shows them), so they are writable even here,
    # where the schema names neither. A field it really lacks is still refused.
    call_tool(w, 'set_entry_field', {'entry_form': 'Ali', 'field': 'gloss', 'value': 'x'})
    assert w.ops[-1]['field'] == 'gloss'
    assert 'has no entry field "definition"' in call_tool(
        w, 'set_entry_field', {'entry_form': 'Ali', 'field': 'definition', 'value': 'x'})
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
