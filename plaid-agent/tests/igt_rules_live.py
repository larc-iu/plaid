"""A seeded live igt project with the layer rules igt's setup declares, a
workspace over it as the requester, for tests that approve a plan through the
real AssistantService (``rule_plan_model.approve``) against a private core."""
import copy

from fixtures import lexicon_raw, project_raw, VOCAB
from live import seed

from plaid_agent.igt.project import load_project
from plaid_agent.igt.workspace import Workspace


def base_project():
    return copy.deepcopy(project_raw())


def workspace(c, s):
    return Workspace(c, load_project(c, s.project_id))


def declare_igt_rules(c, s, project):
    """The layer rules igt's setup declares (plaid-igt domain/igtConstraints.js): coextensive and
    single-link on the morpheme layer, single-link on the word layer, single-span on every field
    (and a value set where its tagset is closed)."""
    from plaid_client.workflows.igt.tagsets import field_constraints
    for tl in project['text_layers']:
        for tk in tl['token_layers']:
            role = ((tk.get('config') or {}).get('plaid') or {}).get('role')
            if role == 'morpheme':
                c.token_layers.set_constraints(s.ids[tk['id']], 'igt', [{'type': 'coextensive'},
                                                                        {'type': 'single-link'}])
            elif role == 'word':
                c.token_layers.set_constraints(s.ids[tk['id']], 'igt', [{'type': 'single-link'}])
            for sl in tk.get('span_layers') or []:
                c.span_layers.set_constraints(s.ids[sl['id']], 'igt',
                                              field_constraints(sl.get('config') or {}, project.get('config') or {}))


def seeded(c, project, docs, lexicon=None, name='igt rules'):
    """``(seed, workspace)``: ``docs`` and ``lexicon`` (the fixture's by default) seeded under
    ``project`` with igt's rules declared."""
    s = seed(c, project, {d['id']: d for d in docs}, {VOCAB: lexicon or lexicon_raw()}, name=name)
    declare_igt_rules(c, s, project)
    return s, workspace(c, s)


def entry(c, s, item):
    """An entry of the fixture's lexicon as stored, by its fixture id."""
    return next(it for it in c.vocab_layers.get(s.ids[VOCAB], include_items=True)['items']
                if it['id'] == s.ids[item])
