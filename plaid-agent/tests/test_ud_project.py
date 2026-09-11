"""The UD project and document model, over the Spanish fixture."""

import pytest

from plaid_agent.ud.project import (load_project, parse_document, parse_ref, render_document,
                                    render_sentence, resolve, word_ref)
from fixtures import FakeClient
from ud_fixtures import DEPREL, FEATS, LEMMA, PID, UPOS, WORD_LAYER, document_raw, project_raw, ud_client


@pytest.fixture
def project():
    return load_project(ud_client(), PID)


@pytest.fixture
def doc(project):
    return parse_document(document_raw(), project)


# --- the project ------------------------------------------------------------

def test_the_layers_are_found_by_role_and_by_ud_flag(project):
    assert project.name == 'Spanish' and project.language == 'es'
    assert project.word_layer_id == WORD_LAYER          # role syntactic-word
    assert project.span_layers['upos'] == UPOS and project.span_layers['features'] == FEATS
    assert project.layer('lemma') == LEMMA
    # The dependency layer hangs off LEMMA, not off the token layer.
    assert project.relation_layer_id == DEPREL


def test_a_project_missing_a_layer_says_which():
    raw = project_raw()
    words = raw['text_layers'][0]['token_layers'][2]
    words['span_layers'] = [s for s in words['span_layers'] if s['id'] != UPOS]
    with pytest.raises(ValueError, match='missing its upos layer'):
        load_project(FakeClient(project=raw, documents={'ud1': document_raw()}), PID)


def test_upos_is_closed_and_xpos_is_the_projects_own(project):
    assert 'VERB' in project.vocab['upos'] and project.modes['upos'] == 'closed'
    assert project.vocab['xpos'] == ['vmip1p0', 'ncms000']
    # Nobody set a deprel vocabulary, so the universal 37 stand, as a hint.
    assert 'nsubj' in project.vocab['deprel'] and project.modes['deprel'] == 'open'
    assert project.vocab['feats']['Number'] == ['Sing', 'Plur']


def test_the_rule_line_says_whether_a_vocabulary_is_a_rule(project):
    assert 'ONLY these values are allowed' in project.rule('upos')
    assert 'others are allowed' in project.rule('deprel')


# --- the document -----------------------------------------------------------

def test_a_multi_word_token_is_one_token_and_two_words(doc):
    s = doc.sentences[0]
    assert [t.surface for t in s.tokens] == ['Vamos', 'al', 'mar', '.']
    al = s.tokens[1]
    assert len(al.words) == 2 and al.ref_range == 'w2-3'
    # Both words cover the whole token: the form comes from the Form span,
    # never from a substring.
    assert [w.form for w in al.words] == ['a', 'el']
    assert all(w.token is al for w in al.words)
    assert [w.index for w in s.words] == [1, 2, 3, 4, 5]


def test_a_plain_token_takes_its_form_from_the_text(doc):
    assert doc.sentences[0].word(1).form == 'Vamos'
    assert doc.sentences[0].word(4).form == 'mar'
    assert doc.sentences[0].word(5).form == '.'


def test_dependencies_read_back_as_conllu_heads(doc):
    s = doc.sentences[0]
    assert (s.word(1).head, s.word(1).deprel) == (0, 'root')   # a self-relation is the root
    assert (s.word(2).head, s.word(2).deprel) == (4, 'case')
    assert (s.word(3).head, s.word(3).deprel) == (4, 'det')
    assert (s.word(4).head, s.word(4).deprel) == (1, 'obl')


def test_an_unannotated_sentence_reads_as_empty_columns(doc):
    s = doc.sentences[1]
    assert [t.surface for t in s.tokens] == ['Corre', '.']
    assert s.word(1).marked('lemma') == '_' and s.word(1).head is None


def test_find_reaches_a_sentence_a_token_and_a_word(doc):
    assert doc.find('us-1') is doc.sentences[0]
    assert doc.find('ut-2') is doc.sentences[0].tokens[1]
    assert doc.find('uw-2b') is doc.sentences[0].word(3)
    assert doc.find('nope') is None


def test_word_count_counts_syntactic_words(doc):
    # Vamos, a, el, mar, . then Corre, . -- the multi-word token is two words.
    assert doc.word_count == 7


# --- addressing --------------------------------------------------------------

def test_refs_are_conllu_shaped():
    assert parse_ref('s3') == (3, None, None)
    assert parse_ref('s3.w2') == (3, 2, None)
    assert parse_ref('s3.w1-2') == (3, 1, 2)
    with pytest.raises(ValueError, match='Bad reference'):
        parse_ref('s3.m1')


def test_resolve_reaches_the_sentence_the_word_and_the_multi_word_token(doc):
    assert resolve(doc, 's1') is doc.sentences[0]
    assert resolve(doc, 's1.w3').form == 'el'
    assert resolve(doc, 's1.w2-3') is doc.sentences[0].tokens[1]
    assert word_ref(doc.sentences[0], doc.sentences[0].word(3)) == 's1.w3'


def test_a_reference_past_the_end_says_what_is_there(doc):
    with pytest.raises(ValueError, match='has 2 sentences'):
        resolve(doc, 's9')
    with pytest.raises(ValueError, match='has 5 words'):
        resolve(doc, 's1.w9')
    with pytest.raises(ValueError, match='no multi-word token spanning'):
        resolve(doc, 's1.w1-2')


# --- rendering ---------------------------------------------------------------

def test_a_sentence_renders_as_conllu_with_a_range_line(doc):
    out = render_sentence(doc.sentences[0])
    lines = out.splitlines()
    assert lines[0] == '# sent_id = s1'
    assert lines[1] == '# text = Vamos al mar.'
    # The corpus's own sent_id does not get a second # sent_id line.
    assert out.count('# sent_id') == 1
    body = [l for l in lines if l and not l.startswith('#')]
    assert body[0].split() == list(('ID', 'FORM', 'LEMMA', 'UPOS', 'XPOS', 'FEATS', 'HEAD', 'DEPREL'))
    assert body[1].split() == ['1', 'Vamos', 'ir', 'VERB', '_', 'Number=Plur', '0', 'root']
    assert body[2].split() == ['2-3', 'al', '_', '_', '_', '_', '_', '_']
    assert body[3].split() == ['2', 'a', 'a', 'ADP', '_', '_', '4', 'case']


def test_an_unconfirmed_machine_value_is_marked(doc):
    out = render_sentence(doc.sentences[0])
    assert 'NOUN~' in out          # the parser's UPOS, nobody has confirmed it
    assert 'VERB~' not in out      # a person's, unmarked


def test_a_document_renders_with_its_metadata_and_a_range(doc):
    whole = render_document(doc)
    assert 'Document "Viaje" (2 sentences, 7 words)' in whole
    assert '# genre = fiction' in whole
    assert '# sent_id = s2' in whole
    part = render_document(doc, from_sentence=2)
    assert 'Showing sentences 2 to 2.' in part and '# sent_id = s1' not in part


def test_an_untokenized_document_says_so(project):
    raw = document_raw()
    for tk in raw['text_layers'][0]['token_layers']:
        tk['tokens'] = []
    out = render_document(parse_document(raw, project))
    assert 'has not been tokenized' in out
