"""The UD prompt, trace and citations, and the service that ties them together."""

import pytest

from plaid_agent.core.trace import DOCUMENT, PLAN, READ, summarize_steps, trace_step
from plaid_agent.ud.citations import parse_refs, resolve_citations
from plaid_agent.ud.project import load_project
from plaid_agent.ud.prompt import build_system_prompt
from plaid_agent.ud.tools import TOOLS, Workspace, call_tool
from plaid_agent.ud.trace import TRACER, describe_step, step_kind
from ud_fixtures import PID, ud_client


@pytest.fixture
def ws():
    client = ud_client()
    return Workspace(client, load_project(client, PID))


# --- the prompt ----------------------------------------------------------------

def test_the_prompt_carries_the_projects_own_vocabularies(ws):
    out = build_system_prompt(ws.project)
    assert 'the project "Spanish"' in out
    assert '- Language: es' in out
    assert '- upos (a RULE): ADJ, ADP' in out
    assert '- xpos (a suggestion): vmip1p0, ncms000' in out
    assert '- deprel (a suggestion): acl, advcl' in out
    assert '- features (a suggestion): Gender=Masc/Fem, Number=Sing/Plur' in out


def test_the_prompt_explains_the_multi_word_token(ws):
    out = build_system_prompt(ws.project)
    assert 'A TOKEN is what the text is divided into. A WORD is what gets annotated.' in out
    assert 's3.w1-2 the multi-word token' in out


def test_the_web_half_is_added_only_when_asked(ws):
    assert 'Looking outside the project' not in build_system_prompt(ws.project)
    out = build_system_prompt(ws.project, web=True)
    assert 'CANNOT also plan changes' in out and 'written by strangers' in out
    assert 'UD guidelines' in out


# --- the trace ------------------------------------------------------------------

def test_every_declared_tool_has_a_line_of_its_own():
    """A tool described only by its own name has been added without a word for
    it, which the user then reads in the trace."""
    nameless = []
    for t in TOOLS:
        name = t['function']['name']
        if describe_step(name, {}) == name.replace('_', ' '):
            nameless.append(name)
    assert not nameless, 'no trace line for: ' + ', '.join(nameless)


def test_a_step_is_classified_by_what_it_was_for():
    assert step_kind('read_document') == DOCUMENT
    assert step_kind('set_head') == PLAN
    assert step_kind('confirm') == PLAN


def test_the_trace_reads_as_past_tense_lines():
    assert describe_step('set_head', {'ref': 's1.w2', 'head': 4, 'deprel': 'case'}) \
        == 'Planned s1.w2 as case of word 4'
    assert describe_step('set_head', {'ref': 's1.w1', 'head': 0}) \
        == 'Planned s1.w1 as the sentence root'
    assert describe_step('set_field', {'field': 'lemma', 'value': 'ir', 'refs': ['s1.w1'],
                                       'document': 'Viaje'}) \
        == 'Planned lemma = “ir” on 1 word in “Viaje”'
    assert describe_step('confirm', {'document': 'Viaje'}) \
        == 'Planned confirming everything awaiting review in “Viaje”'


def test_the_summary_counts_documents_and_plans_apart():
    steps = [trace_step(TRACER, 'a', 'read_document', {'document': 'Viaje'}),
             trace_step(TRACER, 'b', 'set_head', {'ref': 's1.w2', 'head': 1, 'deprel': 'det'})]
    assert summarize_steps(steps) == 'read 1 document · 1 planned change · 2 steps'


# --- citations -------------------------------------------------------------------

def test_a_ref_list_repeats_what_it_leaves_out():
    assert parse_refs('s3.w2,w5') == ['s3.w2', 's3.w5']
    assert parse_refs('s3') == ['s3']
    assert parse_refs('s1.w2-3') == ['s1.w2-3']


def test_a_citation_becomes_the_sentence_with_its_words_marked(ws):
    call_tool(ws, 'read_document', {'document': 'Viaje'})
    out = resolve_citations(ws, 'The oblique is marked: <cite doc="Viaje" ref="s1.w2,w4"/>')
    assert len(out) == 1
    card = out[0]
    assert card['document_name'] == 'Viaje' and card['sentence'] == 1
    assert card['text'] == 'Vamos al mar.'
    assert card['focus'] == [2, 4]
    assert '2-3  al' in card['rows'] and '# sent_id' not in card['rows']


def test_a_multi_word_token_citation_marks_both_its_words(ws):
    call_tool(ws, 'read_document', {'document': 'Viaje'})
    card = resolve_citations(ws, '<cite doc="Viaje" ref="s1.w2-3"/>')[0]
    assert card['focus'] == [2, 3]


def test_a_citation_naming_nothing_real_is_left_out(ws):
    call_tool(ws, 'read_document', {'document': 'Viaje'})
    assert resolve_citations(ws, '<cite doc="Viaje" ref="s9"/>') == []
    assert resolve_citations(ws, '<cite doc="Nope" ref="s1"/>') == []


def test_one_document_read_means_a_bare_reference_is_unambiguous(ws):
    call_tool(ws, 'read_document', {'document': 'Viaje'})
    out = resolve_citations(ws, 'The root is s1.w1 here.')
    assert len(out) == 1 and out[0]['focus'] == [1]


def test_the_same_citation_twice_is_one_card(ws):
    call_tool(ws, 'read_document', {'document': 'Viaje'})
    text = '<cite doc="Viaje" ref="s1"/> and again <cite doc="Viaje" ref="s1"/>'
    assert len(resolve_citations(ws, text)) == 1


# --- the service ------------------------------------------------------------------

def test_the_service_is_the_shared_one_with_uds_half():
    from plaid_agent.core.service import BaseAssistantService
    from plaid_agent.ud.service import AssistantService
    svc = AssistantService()
    assert isinstance(svc, BaseAssistantService)
    assert svc.service_id == 'ud:assist' and svc.APP == 'ud'
    # The conversation record is namespaced by app, so two assistants in one
    # user's store never read each other's conversations.
    from plaid_agent.core.conversation import conv_key
    assert conv_key(svc.APP, 'p1', 'c1') == 'ud:assistant:p1:conv:c1'


def test_the_toolkit_wires_uds_tools_to_the_shared_loop():
    from plaid_agent.ud.service import AssistantService
    kit = AssistantService().toolkit()
    ws = object()
    assert kit.tracer is TRACER
    assert {t['function']['name'] for t in kit.tools_for(_NoWeb())} >= {'read_document', 'set_head'}


class _NoWeb:
    web = None
