"""A tagset out of force on a field (REV5-WIRE-1, ruling (a) of FX-E): the
field's layer does not hold what its settings asked for before the plan (a
closed list the stored values break, rules a script left). igt's settings
save, Add to tagset and an approved plan write the change all the same, the
field stays out of force, and Validation names the values in the way. The
assistant says so, and ``write_settings`` (the app's write in Python) writes
it the same way: declared in the batch only for a field in force, nothing
repaired, then the plan's own fields put in force as far as their values
allow. Against a live core."""

import pytest
from fixtures import project_raw, document_raw, lexicon_raw, VOCAB, MGLOSS, GLOSS
from live import live_client, seed  # noqa: F401 - fixture

from plaid_agent.igt.toolkit import call_tool
from plaid_client.workflows.igt.tagsets import field_constraints
from test_tagset_tools import declare_igt_rules, igt_config, layer, run, ws_of


@pytest.fixture
def proj(live_client):
    s = seed(live_client, project_raw(), {'d1': document_raw()}, {VOCAB: lexicon_raw()},
             name='igt-agent tagset out of force test')
    declare_igt_rules(s)
    yield s
    s.delete()


def _out_of_force(s):
    """Leipzig closed and in force on Morph Gloss, then its list taken off
    (as an import ended as it is leaves it) and QQ and ZZ written."""
    ws = ws_of(s)
    call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig', 'changes': {'mode': 'closed', 'add': ['Ali']}})
    run(s, ws)
    assert any(r['type'] == 'value-set' for r in layer(s, MGLOSS)['constraints']['igt'])
    s.client.span_layers.set_constraints(s.ids[MGLOSS], 'igt', [{'type': 'single-span'}])
    s.client.spans.create(s.ids[MGLOSS], [s.ids['m-2']], 'QQ')
    s.client.spans.create(s.ids[MGLOSS], [s.ids['m-4a']], 'ZZ')


def rules(s, lid):
    return (layer(s, lid).get('constraints') or {}).get('igt')


def test_a_change_to_a_tagset_out_of_force_is_written_and_the_field_stays_out(proj):
    _out_of_force(proj)
    ws = ws_of(proj)
    out = call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig', 'changes': {'add': ['NEW']}})
    assert 'Core will refuse' not in out, out
    assert ('Approval writes it. "Leipzig" stays out of force on Morph Gloss, held off by 2 stored values: '
            '"QQ" (1), "ZZ" (1).') in out, out
    run(proj, ws)
    assert [v['value'] for v in igt_config(proj)['tagsets']['Leipzig']['values']] == ['PL', 'ERG', 'Ali', 'NEW']
    assert rules(proj, MGLOSS) == [{'type': 'single-span'}]


def test_the_plan_that_lists_the_values_in_the_way_puts_the_list_in_force(proj):
    _out_of_force(proj)
    ws = ws_of(proj)
    out = call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig', 'changes': {'add': ['QQ', 'ZZ']}})
    assert 'Core will refuse' not in out and 'out of force' not in out, out
    run(proj, ws)
    vs = next(r for r in rules(proj, MGLOSS) if r['type'] == 'value-set')
    assert vs['values'] == ['PL', 'ERG', 'Ali', 'QQ', 'ZZ']


def test_a_field_with_no_rules_and_a_doubled_word_is_not_repaired(proj):
    """A script-made field (no rules) holding two annotations on one word:
    a plan that closes its tagset writes, joins nothing, and declares only
    what the data allows (the list, not one annotation a word)."""
    proj.client.span_layers.delete_constraints(proj.ids[GLOSS], 'igt')
    proj.client.spans.create(proj.ids[GLOSS], [proj.ids['w-1']], 'Ali')
    ws = ws_of(proj)
    call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Words', 'changes': {'mode': 'closed', 'add': ['Ali']}})
    out = call_tool(ws, 'tagsets', {'action': 'assign', 'field': 'Gloss', 'tagset': 'Words'})
    assert 'Core will refuse' not in out, out
    run(proj, ws)
    assert layer(proj, GLOSS)['config']['igt']['tagset'] == 'Words'
    assert [r['type'] for r in rules(proj, GLOSS)] == ['value-set']
    doc = proj.client.documents.get(proj.ids['d1'], include_body=True)
    spans = [sp for tl in doc['text_layers'] for tk in tl['token_layers'] for sl in tk.get('span_layers') or []
             if sl['id'] == proj.ids[GLOSS] for sp in sl.get('spans') or []]
    assert sorted(sp['value'] for sp in spans) == ['Ali', 'Ali'], spans


def test_a_field_in_force_is_still_refused_whole(proj):
    ws = ws_of(proj)
    out = call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig', 'changes': {'mode': 'closed'}})
    assert 'Core will refuse this approval' in out, out
    from plaid_client import PlaidAPIError
    with pytest.raises(PlaidAPIError):
        run(proj, ws)
    assert rules(proj, MGLOSS) == field_constraints(layer(proj, MGLOSS)['config'], {'igt': igt_config(proj)})


# --- the invariant over a generated sweep ----------------------------------------------
#
# For a random field state (rules as wanted, one span a token only, none, a
# list without one span a token, a stale list), random stored values (a
# person's, on and off the list, a doubled word) and a random plan (a value
# added or removed, a mode, an assignment): the edit's answer says core
# refuses exactly when approval is refused, approval is refused exactly when
# a field in force before it would take a list core refuses, no annotation
# changes, and after it every field the plan changes holds what its settings
# want or core refuses what it lacks, with every rule it held and still wants.

import random

from plaid_client import PlaidAPIError

POOL = ['PL', 'ERG', 'Ali', 'QQ', 'NOM', 'ZZ']


def _spans(s):
    doc = s.client.documents.get(s.ids['d1'], include_body=True)
    return sorted((sl['id'], sp['id'], sp['value'], tuple(sp['tokens'])) for tl in doc['text_layers']
                  for tk in tl['token_layers'] for sl in tk.get('span_layers') or [] for sp in sl.get('spans') or [])


def _refuses(s, lid, wanted):
    """What core refuses of ``wanted`` on layer ``lid`` over the stored data."""
    why = []
    vs = next((c for c in wanted if c['type'] == 'value-set'), None)
    if vs and s.client.span_layers.refused_values(lid, vs)['count']:
        why.append('value-set')
    others = [c for c in wanted if c['type'] != 'value-set']
    if others:
        found = s.client.span_layers.check_constraints(lid, others)
        if found.get('violation_count') or found.get('violation-count') or found.get('violations'):
            why.append('rules')
    return why


def _canon(rules):
    import json
    return json.dumps(rules or [], sort_keys=True)


@pytest.mark.parametrize('seed_n', range(int(__import__('os').environ.get('TAGSET_SWEEP', '24'))))
def test_a_generated_plan_keeps_the_invariant(live_client, seed_n):
    rnd = random.Random(seed_n)
    s = seed(live_client, project_raw(), {'d1': document_raw()}, {VOCAB: lexicon_raw()},
             name=f'igt-agent tagset sweep {seed_n}')
    try:
        if rnd.random() < 0.5:
            cfg = igt_config(s)
            cfg['tagsets']['Leipzig']['mode'] = 'closed'
            cfg['tagsets']['Leipzig']['values'].append({'value': 'Ali'})
            s.client.projects.set_config(s.project_id, 'igt', 'tagsets', cfg['tagsets'])
        if rnd.random() < 0.4:
            s.client.span_layers.set_config(s.ids[GLOSS], 'igt', 'tagset', 'Leipzig')
        declare_igt_rules(s)
        for lid in (MGLOSS, GLOSS):
            shape = rnd.choice(['wanted', 'wanted', 'single', 'none', 'list-only', 'stale'])
            lst = {'type': 'value-set', 'values': ['PL', 'ERG', 'Ali', 'QQ'], 'delimiters': '.:', 'parts': 'all'}
            if shape == 'single':
                s.client.span_layers.set_constraints(s.ids[lid], 'igt', [{'type': 'single-span'}])
            elif shape == 'none':
                s.client.span_layers.delete_constraints(s.ids[lid], 'igt')
            elif shape == 'list-only':
                s.client.span_layers.set_constraints(s.ids[lid], 'igt', [lst])
            elif shape == 'stale':
                s.client.span_layers.set_constraints(s.ids[lid], 'igt', [{'type': 'single-span'}, lst])
        for tok in ('m-2', 'm-4a', 'm-4b'):
            if rnd.random() < 0.5:
                try:
                    s.client.spans.create(s.ids[MGLOSS], [s.ids[tok]], rnd.choice(POOL))
                except PlaidAPIError:
                    pass
        if rnd.random() < 0.4:
            try:
                s.client.spans.create(s.ids[GLOSS], [s.ids['w-1']], rnd.choice(POOL))
            except PlaidAPIError:
                pass

        ws = ws_of(s)
        kind = rnd.choice(['add', 'remove', 'mode', 'assign'])
        if kind == 'add':
            change = {'add': [rnd.choice(POOL)]}
        elif kind == 'remove':
            change = {'remove': [rnd.choice(['PL', 'ERG', 'Ali'])]}
        elif kind == 'mode':
            change = {'mode': rnd.choice(['closed', 'mixed', 'suggest'])}
        if kind == 'assign':
            out = call_tool(ws, 'tagsets', {'action': 'assign', 'field': 'Gloss',
                                            'tagset': rnd.choice(['Leipzig', ''])})
        else:
            out = call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig', 'changes': change})
        tag = f'seed {seed_n}: {kind} -> {out}'
        if not ws.ops:
            return

        p = s.client.projects.get(s.project_id)
        from plaid_agent.igt.tagsets import _field_rules, _span_layers, settings_ops
        rows = _field_rules(p['config'], _span_layers(p), settings_ops(ws.ops))
        expect_refused = any(r['changes'] and r['in_force'] and _canon(r['wanted']) != _canon(r['stored'])
                             and 'value-set' in _refuses(s, r['id'], r['wanted']) for r in rows)
        assert ('Core will refuse' in out) == expect_refused, tag
        before = _spans(s)
        stored_before = {r['id']: r['stored'] or [] for r in rows}
        try:
            run(s, ws)
            refused = False
        except PlaidAPIError as e:
            assert e.status == 422, tag
            refused = True
        assert refused == expect_refused, tag
        assert _spans(s) == before, tag
        if refused:
            return
        p = s.client.projects.get(s.project_id)
        for sl in _span_layers(p):
            r = next(r for r in rows if r['id'] == sl['id'])
            if not r['changes']:
                continue
            wanted = field_constraints(sl.get('config'), p.get('config'))
            stored = (sl.get('constraints') or {}).get('igt') or []
            if _canon(stored) != _canon(wanted):
                assert _refuses(s, sl['id'], wanted), f'{tag}: {sl["name"]} holds {stored}, core refuses nothing'
            for c in stored_before[sl['id']]:
                if any(_canon([c]) == _canon([w]) for w in wanted):
                    assert any(_canon([c]) == _canon([x]) for x in stored), f'{tag}: {sl["name"]} lost {c}'
    finally:
        s.delete()
