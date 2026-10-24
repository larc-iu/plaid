"""The project ends with exactly the expected values changed and nothing else.

args:
  reader:   igt | ud | umr (common.<reader>_values)
  document: the document the expected changes are in
  expect:   {address: value}  (value null: the address must be gone)
  prov:     verified | human | any   (default verified: what an approved plan
            stamps unless "Record as human-made" was ticked)
  plan:     required | none          (default required: a plan was made and
            applied. none: nothing may be written, for a question or a refusal)

Pass when every expected address has its value, no other address in any of
the project's documents changed, and (for verified) every expected span
carries the verified machine stamp.

Measures: target_ok (expected addresses right / expected), collateral (count
and the first few addresses), prov_ok, plan_status, plan_rows.
"""
import common as c

READERS = {'igt': (c.igt_values, c.igt_spans), 'ud': (c.ud_values, c.ud_spans), 'umr': (c.umr_values, None)}


def _umr_span(doc, address):
    s, var = address.split(':', 1)[0].split('.', 1)
    tl = doc['text_layers'][0]
    for tk in tl['token_layers']:
        for sl in tk.get('span_layers') or []:
            if ((sl.get('config') or {}).get('umr') or {}).get('concepts'):
                for sp in sl.get('spans') or []:
                    if ((sp.get('metadata') or {}).get('umr') or {}).get('var') == var:
                        return sp
    return None


def plan_items(conversation):
    return [d for d in conversation.get('display') or [] if d.get('kind') == 'assistant' and d.get('plan')]


def check(ctx):
    a = ctx.args
    values, spans = READERS[a['reader']]
    doc = next(d for d in ctx.project['documents'] if d['name'] == a['document'])
    expect = a.get('expect') or {}
    changes = c.project_changes(ctx, values)
    after = ctx.client.documents.get(doc['id'], include_body=True)
    now = values(after)
    hits = {k: now.get(k) == v for k, v in expect.items()}
    # An expected change may restamp what it changes (an approved plan does).
    expected_keys = [f'{a["document"]}|{k}' for k in expect] + \
        [f'{a["document"]}|{k}#prov' for k in expect] + \
        [f'{a["document"]}|{k.split(":", 1)[0]}#prov' for k in expect if a['reader'] == 'umr']
    flat = {f'{name}|{k}': v for name, ch in changes.items() for k, v in ch.items()}
    flat.update(c.guideline_changes(ctx))
    extra = c.collateral(flat, expected_keys)

    want_prov = a.get('prov', 'verified')
    prov_ok = None
    if want_prov != 'any' and expect:
        ok = []
        for k in expect:
            if a['reader'] == 'umr':
                sp = _umr_span(after, k)
            else:
                sp = spans(after).get(k)
            p = c.prov_of(sp)
            ok.append(c.verified_machine(sp) if want_prov == 'verified' else not p)
        prov_ok = all(ok)

    plans = plan_items(ctx.conversation)
    statuses = [p.get('status') for p in plans]
    want_plan = a.get('plan', 'required')
    plan_ok = ('applied' in statuses) if want_plan == 'required' else not flat
    passed = all(hits.values()) and not extra and plan_ok and prov_ok is not False
    return {
        'pass': passed,
        'measures': {
            'target_ok': f'{sum(hits.values())}/{len(hits)}',
            'collateral': len(extra),
            'collateral_first': {k: flat[k] for k in extra[:10]},
            'prov_ok': prov_ok,
            'plan_status': statuses,
            'plan_rows': [len((p.get('plan') or {}).get('proposed') or (p.get('plan') or {}).get('ops') or [])
                          for p in plans],
        },
        'detail': {'expected': {k: [now.get(k), v] for k, v in expect.items()},
                   'changes': {n: {k: list(v) for k, v in ch.items()} for n, ch in changes.items()}},
    }
