"""A sweep over igt's respelling rule (R6, test_respell_rule.py): random plans
of one to four respell_all calls over two documents, with and without morpheme
forms and headwords, held to one document or not, then text typed before the words or over a word the plan respells, approved through the
service on a live private core, against an independent model: each
respelling applied in plan order to the spelling the ones before it leave.

``RESPELL_SWEEP_N`` sets the number of cases (default 8), and
``RESPELL_SWEEP_SEED`` the first seed.
"""
import os
import random
import re

import pytest

from live import live_client, seed  # noqa: F401
from fixtures import lexicon_raw, VOCAB
from rule_plan_model import approve, project
from test_rule_restate_live import _doc

from plaid_agent.igt.project import load_project
from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.workspace import Workspace

N = int(os.environ.get('RESPELL_SWEEP_N', '8'))
FIRST = int(os.environ.get('RESPELL_SWEEP_SEED', '0'))
STEMS = ['ka', 'to', 'mi', 'gam', 'tao', 'kano', 'ma']
SUFFIXES = ['s', 'n', 'ak']
PATTERNS = ['a', 'o', 'k', 'm', 'ka', 'am', 'ä', 'ö', 'n', 'gam', 'to']
REPLACEMENTS = ['ä', 'ö', 'g', 'kh', 'e', 'a', 'o', 'mm']


def _docs(rng):
    out = {}
    for d, name in (('d0', 'Doc A'), ('d1', 'Doc B')):
        words = []
        for _ in range(rng.randint(3, 6)):
            parts = [rng.choice(STEMS)] + ([rng.choice(SUFFIXES)] if rng.random() < 0.5 else [])
            words.append((''.join(parts), '', [(p, '') for p in parts]))
        out[d] = _doc(d, name, words)
    return out


def _rep(spec):
    flags = 0 if spec['case_sensitive'] else re.IGNORECASE
    pat = re.escape(spec['pattern'])

    def rep(v):
        if spec['whole']:
            return spec['replacement'] if re.fullmatch(pat, v, flags) else v
        return re.sub(pat, lambda _m: spec['replacement'], v, flags=flags)
    return rep


def _state(docs):
    """Each document's words, as [spelling, [morpheme forms]], and the
    headwords, as stored."""
    words = {}
    for raw in docs.values():
        layers = raw['text_layers'][0]['token_layers']
        body = raw['text_layers'][0]['text']['body']
        words[raw['name']] = [[body[t['begin']:t['end']], [m['metadata']['form'] for m in layers[2]['tokens']
                                                           if (m['begin'], m['end']) == (t['begin'], t['end'])]]
                              for t in layers[1]['tokens']]
    return {'words': words, 'heads': [it['form'] for it in lexicon_raw()['items']]}


def _apply(state, spec) -> bool:
    """One respelling over ``state``, in place. True when it finds anything
    to change (a word, and with it a morpheme form, or a headword)."""
    rep = _rep(spec)
    found = False
    for name, ws_ in state['words'].items():
        if spec['document'] and spec['document'] != name:
            continue
        for w in ws_:
            new = rep(w[0])
            if new == w[0]:
                continue
            found = True
            w[0] = new
            if spec['morpheme_forms']:
                w[1] = [rep(f) if rep(f).strip() else f for f in w[1]]
    if spec['lexicon']:
        heads = [rep(h) if rep(h).strip() else h for h in state['heads']]
        found = found or heads != state['heads']
        state['heads'] = heads
    return found


def _applied(docs, plan):
    state = _state(docs)
    for spec in plan:
        _apply(state, spec)
    return state


def _plan_of(docs, requests):
    """The plan the calls make, in order: a respelling
    that finds nothing is not staged, and one asked again moves last when it
    finds something there, else stays where it is."""
    plan = []
    for spec in requests:
        others = [p for p in plan if p != spec]
        state = _applied(docs, others)
        if _apply(state, spec):
            plan = others + [spec]
    return plan


def _model(docs, plan):
    """(body, words, morpheme forms) per document name and the headwords, as
    the plan's respellings in order leave them."""
    state = _applied(docs, plan)
    out = {name: (' '.join(w[0] for w in ws_), [w[0] for w in ws_], [f for w in ws_ for f in w[1]])
           for name, ws_ in state['words'].items()}
    return out, sorted(state['heads'])


def _read(c, pid):
    ws = Workspace(c, load_project(c, pid))
    out = {}
    for name in ('Doc A', 'Doc B'):
        d = ws.doc(name)
        out[name] = (d.body, [w.surface for st in d.sentences for w in st.words],
                     [m.form for st in d.sentences for w in st.words for m in w.morphemes])
    return out, sorted(it['form'] for v in ws.project.vocabs for it in ws.lexicon(v))


@pytest.mark.parametrize('case', range(FIRST, FIRST + N))
def test_respellings_compose_as_asked_in_order(live_client, case):
    rng = random.Random(case)
    c = live_client
    docs = _docs(rng)
    s = seed(c, project(), docs, {VOCAB: lexicon_raw()}, name=f'respell sweep {case}')
    try:
        ws = Workspace(c, load_project(c, s.project_id))
        asked = []
        ids = {name: ws.doc(name).id for name in ('Doc A', 'Doc B')}

        def staged():
            return [(o['args']['pattern'], o['args']['replacement'], o['args']['whole'],
                     o['args']['case_sensitive'], o['args']['morpheme_forms'], o['args']['lexicon'],
                     o['args'].get('document')) for o in ws.ops]

        def expected(plan):
            return [(p['pattern'], p['replacement'], p['whole'], p['case_sensitive'], p['morpheme_forms'],
                     p['lexicon'], ids.get(p['document'])) for p in plan]
        for _ in range(rng.randint(1, 4)):
            pattern = rng.choice(PATTERNS)
            spec = {'pattern': pattern, 'replacement': rng.choice([r for r in REPLACEMENTS if r != pattern]),
                    'whole': rng.random() < 0.25, 'case_sensitive': rng.random() < 0.5,
                    'morpheme_forms': rng.random() < 0.7, 'lexicon': rng.random() < 0.5,
                    'document': rng.choice([None, None, 'Doc A', 'Doc B'])}
            out = call_tool(ws, 'respell_all', {k: v for k, v in spec.items() if v is not None})
            assert not out.startswith('Error'), (case, spec, out)
            asked.append(spec)
        plan = _plan_of(docs, asked)
        assert staged() == expected(plan), (case, asked, staged())
        want, heads = _model(docs, plan)
        before, _ = _read(c, s.project_id)
        edit = rng.choice(['none', 'before', 'over']) if ws.ops else 'none'
        changed = [n for n in want if want[n][1] != before[n][1]]
        if edit == 'over' and not changed:
            edit = 'before'
        if edit != 'none':
            name = rng.choice(changed) if edit == 'over' else rng.choice(['Doc A', 'Doc B'])
            d = ws.doc(name)
            if edit == 'before':
                c.texts.update(d.text_id, [{'type': 'insert', 'index': 0, 'value': 'zz '}])
                want[name] = ('zz ' + want[name][0],) + want[name][1:]
            else:
                ws_ = [w for st in d.sentences for w in st.words]
                i = next(i for i, w in enumerate(ws_) if want[name][1][i] != w.surface)
                w = ws_[i]
                c.texts.update(d.text_id, [{'type': 'replace', 'index': w.begin, 'length': w.end - w.begin,
                                            'value': 'qq'}])
        _p, h, _ = approve(c, s.project_id, ws)
        got, got_heads = _read(c, s.project_id)
        if edit == 'over':
            assert h.errors and 'Since it was planned' in h.errors[0], (case, h.errors, h.done)
            return
        if not ws.ops:
            assert h is None or not h.errors, h.errors
            return
        assert not h.errors, (case, asked, h.errors)
        assert got == want, (case, asked, edit, got, want)
        assert got_heads == heads, (case, asked, got_heads, heads)
    finally:
        s.delete()
