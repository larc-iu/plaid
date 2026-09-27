"""What a turn that may read other projects shows the model and the user:
the tool schemas, the system prompt, the stamp on the question, the
citations, and what the record says about a project that did not open."""

import sys

import pytest

sys.path.insert(0, 'tests')

from multi_fixtures import (OTHER_ID, OTHER_NAME, client, home_workspace, reached,  # noqa: E402
                            reads_in, service)

from plaid_agent.core import prompt as shared  # noqa: E402
from plaid_agent.core import service as service_mod  # noqa: E402
from plaid_agent.core.agent import ModelConfig, TurnResult  # noqa: E402
from plaid_agent.core.conversation import ConversationStore, build_meta  # noqa: E402
from plaid_agent.core.limits import OTHER_PROJECT_CHARS  # noqa: E402
from plaid_agent.core.reach import LOCAL_TOOLS, PLAN_TOOLS  # noqa: E402
from plaid_agent.core.service import projects_stamped, stamped  # noqa: E402

APPS = ('igt', 'ud', 'umr')
DOC = {'igt': 'Text 1', 'ud': 'Viaje', 'umr': 'Story'}


# --- the schemas -------------------------------------------------------------------

@pytest.mark.parametrize('app', APPS)
def test_a_turn_on_one_project_is_offered_exactly_todays_tools(app):
    c = client(app)
    svc, ws = home_workspace(app, c)
    kit = svc.toolkit()
    before = kit.tools_for(ws)
    assert not any('project' in t['function']['parameters']['properties'] for t in before)
    # A reach whose projects all failed to open offers the same tools too.
    svc2, c2, ws2, r = reached(app, served=False)
    assert kit.tools_for(ws2) == before


@pytest.mark.parametrize('app', APPS)
def test_read_tools_take_the_project_and_plan_tools_do_not(app):
    svc, c, ws, r = reached(app)
    kit = svc.toolkit()
    import importlib
    write = importlib.import_module(f'plaid_agent.{app}.toolkit').WRITE_TOOLS
    offered = kit.tools_for(ws)
    takes = {t['function']['name'] for t in offered if 'project' in t['function']['parameters']['properties']}
    names = {t['function']['name'] for t in offered}
    assert takes, 'some read tool takes the project'
    assert not takes & write and not takes & set(PLAN_TOOLS) and not takes & LOCAL_TOOLS
    assert not {n for n in takes if n.endswith('_help')}
    for must in ('project_overview', 'list_documents', 'read_document', 'read_guideline', 'query'):
        assert must in takes, must
    assert names - takes >= write
    one = next(t for t in offered if t['function']['name'] == 'read_document')
    prop = one['function']['parameters']['properties']['project']
    assert prop['enum'] == [ws.project.name, OTHER_NAME]
    assert prop['description'] == f'Which project to read. Leave it out for "{ws.project.name}".'
    # The module's own table is untouched: the next single-project turn sees today's tools.
    c1 = client(app)
    _, ws1 = home_workspace(app, c1)
    assert not any('project' in t['function']['parameters']['properties'] for t in kit.tools_for(ws1))


# --- the prompt --------------------------------------------------------------------

def test_a_brief_is_cut_at_its_budget_and_says_where_the_rest_is():
    shape = '\n'.join(f'- Field {i}: ' + 'x' * 80 for i in range(200))
    brief = shared.project_brief('B', shape, ['T1', 'T2'])
    assert len(brief) <= OTHER_PROJECT_CHARS
    assert brief.startswith('PROJECT: "B"\n- Field 0')
    assert brief.endswith('project_overview with project="B" shows the rest.')
    short = shared.project_brief('B', '- Field: Gloss', ['T1'])
    assert short == ('PROJECT: "B"\n- Field: Gloss\n'
                     '- Guidelines: "T1" (read_guideline with project="B")')
    assert shared.project_brief('B', '- Field: Gloss', []).endswith('- Guidelines: none written')


def test_a_cut_brief_keeps_the_guideline_titles_which_the_overview_does_not_show():
    # The cut's tail sends the model to project_overview, and the overview
    # lists no guidelines, so the titles are kept and the shape is cut first.
    shape = '\n'.join(f'- Field {i}: ' + 'x' * 80 for i in range(200))
    brief = shared.project_brief('B', shape, ['Loanwords', 'Tense'])
    assert len(brief) <= OTHER_PROJECT_CHARS
    assert '- Guidelines: "Loanwords", "Tense" (read_guideline with project="B")' in brief
    assert brief.endswith('project_overview with project="B" shows the rest.')
    # A manual whose titles alone overrun the budget names as many as fit, and says how many more.
    many = [f'Guideline number {i}' for i in range(400)]
    brief = shared.project_brief('B', shape, many)
    assert len(brief) <= OTHER_PROJECT_CHARS
    assert '"Guideline number 0"' in brief and '"Guideline number 399"' not in brief
    shown = brief.count('"Guideline number ')
    assert f'and {400 - shown} more' in brief
    # Cut in its titles alone, the shape is whole and the tail is not said.
    short = shared.project_brief('B', '- Field: Gloss', many)
    assert len(short) <= OTHER_PROJECT_CHARS and '- Field: Gloss' in short
    assert 'shows the rest' not in short and short.endswith('(read_guideline with project="B")')


@pytest.mark.parametrize('app', APPS)
def test_another_projects_guidelines_are_titles_only(app):
    svc, c, ws, r = reached(app)
    note = svc.other_projects_note(r)
    assert note.startswith('OTHER PROJECTS IN THIS CONVERSATION\n'
                           f'The user is working in "{ws.project.name}"')
    assert f'PROJECT: "{OTHER_NAME}"' in note
    assert '"Loanwords"' in note and '"Tense"' in note
    assert 'PINNED-FOREIGN-BODY' not in note and 'Mark tense' not in note
    assert f'(read_guideline with project="{OTHER_NAME}")' in note


@pytest.mark.parametrize('app', APPS)
def test_the_brief_is_the_apps_own_shape(app):
    import importlib
    prompt = importlib.import_module(f'plaid_agent.{app}.prompt')
    svc, c, ws, r = reached(app)
    brief = svc.project_brief(r.others[0])
    assert brief and brief.split('\n')[0] in prompt.build_system_prompt(ws.project)


def test_a_project_that_did_not_open_is_named():
    svc, c, ws, r = reached('igt', joined=[{'id': OTHER_ID, 'name': OTHER_NAME},
                                           {'id': 'gone', 'name': 'Gone'}])
    note = svc.other_projects_note(r)
    assert note.endswith('"Gone" could not be opened.')
    svc, c, ws, r = reached('igt', served=False)
    note = svc.other_projects_note(r)
    assert 'none of them could be opened' in note and note.endswith('"Second" could not be opened.')


# --- the stamp ---------------------------------------------------------------------

def _user(text):
    return {'role': 'user', 'content': text}


def test_the_projects_stamp_is_written_only_when_the_set_changes():
    t = [_user('first')]
    one = projects_stamped(t, ['A'])
    assert one == t, 'a conversation that never joined a project carries no stamp'
    two = projects_stamped(t, ['A', 'B'])
    assert two[-1]['content'] == '[Projects in this conversation: "A", "B"]\n\nfirst'
    again = projects_stamped(two + [{'role': 'assistant', 'content': 'ok'}, _user('next')], ['A', 'B'])
    assert again[-1]['content'] == 'next'
    dropped = projects_stamped(two + [_user('later')], ['A'])
    assert dropped[-1]['content'] == '[Projects in this conversation: "A" only]\n\nlater'
    still = projects_stamped(dropped + [_user('more')], ['A'])
    assert still[-1]['content'] == 'more'


def test_the_place_stamp_stays_first_on_the_line():
    t = projects_stamped([_user('q')], ['A', 'B'])
    t = stamped(t, ('document', 'Text 1'))
    assert t[-1]['content'].startswith('[Asked from the document "Text 1"]\n\n'
                                       '[Projects in this conversation: "A", "B"]\n\nq')
    # And both are found again on the next turn, so neither repeats.
    nxt = projects_stamped(t + [_user('r')], ['A', 'B'])
    assert stamped(nxt, ('document', 'Text 1'))[-1]['content'] == 'r'


# --- a whole turn --------------------------------------------------------------------

def _svc(app):
    svc = service(app)
    svc.cfg = ModelConfig(model='fake/model')
    svc.kit = svc.toolkit()
    return svc


def _seed(c, app, projects, pid):
    store = ConversationStore(c, 'u@x', pid, app)
    user = {'kind': 'user', 'text': 'Compare.'}
    if projects is not None:
        user['projects'] = projects
    conv = {'messages': [_user('Compare.')], 'display': [user]}
    meta = build_meta(None, 'c1', conv, f'{app}:assist:fake', 'fake/model',
                      pending={'kind': 'turn', 'request_id': 'r1', 'service_id': f'{app}:assist:fake'})
    store.save('c1', conv, meta)
    return store


class _Helper:
    request_id = 'r1'
    cancelled = False

    def __init__(self):
        self.done, self.errors = [], []

    def progress(self, *a, **k):
        pass

    def complete(self, data=None):
        self.done.append(data)

    def error(self, e):
        self.errors.append(str(e))


@pytest.mark.parametrize('app', APPS)
def test_a_turn_reads_the_other_project_and_says_what_did_not_open(app, monkeypatch):
    c = client(app)
    pid = c.project['id']
    store = _seed(c, app, [{'id': OTHER_ID, 'name': OTHER_NAME}, {'id': 'gone', 'name': 'Gone'}], pid)
    seen = {}

    def fake_run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text=None):
        seen['system'], seen['transcript'], seen['tools'] = system, transcript, kit.tools_for(ws)
        out = kit.call_tool(ws, 'read_document', {'document': DOC[app], 'project': OTHER_NAME})
        assert not out.startswith('Error'), out
        text = f'There: <cite project="{OTHER_NAME}" doc="{DOC[app]}" ref="s1"/>'
        return TurnResult(text, [{'role': 'assistant', 'content': text}], [])

    monkeypatch.setattr(service_mod, 'run_turn', fake_run_turn)
    helper = _Helper()
    _svc(app).process_request({'requester_client': c, 'requester_id': 'u@x', 'project_id': pid,
                               'conversation_id': 'c1'}, helper)
    assert not helper.errors, helper.errors
    home_name = c.project['name']
    assert seen['transcript'][-1]['content'] == (
        f'[Projects in this conversation: "{home_name}", "{OTHER_NAME}"]\n\nCompare.')
    assert 'OTHER PROJECTS IN THIS CONVERSATION' in seen['system']
    assert '"Gone" could not be opened.' in seen['system']
    conv, _ = store.load('c1')
    item = conv['display'][-1]
    assert item['unavailable_projects'] == [{'id': 'gone', 'name': 'Gone'}]
    assert reads_in(c, OTHER_ID), 'the other project was read with the requester client'


@pytest.mark.parametrize('app', APPS)
def test_a_turn_with_no_other_projects_is_todays_turn(app, monkeypatch):
    c = client(app)
    pid = c.project['id']
    store = _seed(c, app, None, pid)
    seen = {}

    def fake_run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text=None):
        seen['system'], seen['transcript'], seen['reach'] = system, transcript, ws.reach
        return TurnResult('ok', [{'role': 'assistant', 'content': 'ok'}], [])

    monkeypatch.setattr(service_mod, 'run_turn', fake_run_turn)
    svc = _svc(app)
    svc.process_request({'requester_client': c, 'requester_id': 'u@x', 'project_id': pid,
                         'conversation_id': 'c1'}, _Helper())
    assert seen['reach'] is None and seen['transcript'][-1]['content'] == 'Compare.'
    project = svc.load_project(c, pid)
    assert seen['system'] == svc.system_prompt(project, web=False)
    conv, _ = store.load('c1')
    assert 'unavailable_projects' not in conv['display'][-1]


@pytest.mark.parametrize('app', APPS)
@pytest.mark.parametrize('projects', [[], 'home', [{'name': 'No id'}, 'junk']])
def test_a_projects_list_that_names_no_other_project_is_todays_turn(app, projects, monkeypatch):
    # A list naming only the conversation's own project, or nothing usable,
    # adds no project: the turn is exactly a one-project turn, with no
    # paragraph saying other projects failed to open.
    c = client(app)
    pid = c.project['id']
    store = _seed(c, app, [{'id': pid, 'name': 'Home'}] if projects == 'home' else projects, pid)
    seen = {}

    def fake_run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text=None):
        seen['system'], seen['transcript'], seen['reach'] = system, transcript, ws.reach
        return TurnResult('ok', [{'role': 'assistant', 'content': 'ok'}], [])

    monkeypatch.setattr(service_mod, 'run_turn', fake_run_turn)
    svc = _svc(app)
    svc.process_request({'requester_client': c, 'requester_id': 'u@x', 'project_id': pid,
                         'conversation_id': 'c1'}, _Helper())
    assert seen['reach'] is None and seen['transcript'][-1]['content'] == 'Compare.'
    assert seen['system'] == svc.system_prompt(svc.load_project(c, pid), web=False)
    conv, _ = store.load('c1')
    assert 'unavailable_projects' not in conv['display'][-1]
