import common as c
import handwrite as h
import igtlib as L

RULES = {('kx', 'SUBR'): 'SBRD', ('tq', 'RL'): 'REAL', ('pe', 'COS'): 'CS', ('nz', 'NMLZ1'): 'NMLZ'}


def _change(ctx, rules=RULES, skip_doc=None, extra=None):
    for d in ctx.project['documents']:
        if d['name'] == skip_doc:
            continue
        v = c.igt_values(L.raw(ctx, d['name']))
        refs = {}
        for k, x in v.items():
            if not k.endswith(':form'):
                continue
            a, g = k[:-5], v.get(k[:-5] + ':Gloss')
            new = rules.get((str(x).lower(), g))
            if new is None and extra:
                new = extra(str(x).lower(), g)
            if new is not None:
                refs[a] = new
        L.set_field(ctx, d['name'], refs)


def right(ctx):
    # With the lexicon senses renamed too, which the task allows.
    _change(ctx)
    for (f, g), new in RULES.items():
        L.patch_entry(ctx, f'{f}|{g}', {'gloss': new})


def wrong_substring_rl(ctx):
    # A replace of RL inside every gloss: tz's RL.3AUG and RL.PAS change too.
    _change(ctx, extra=lambda f, g: g.replace('RL', 'REAL') if g and g.startswith('RL.') else None)


def wrong_by_form_only(ctx):
    # Every tq, pe and nz rewritten, the numeral, "plant" and 3AUG among them.
    _change(ctx, extra=lambda f, g: {'tq': 'REAL', 'pe': 'CS', 'nz': 'NMLZ'}.get(f))


def wrong_three_of_four(ctx):
    _change(ctx, rules={k: v for k, v in RULES.items() if k[0] != 'nz'})


def wrong_one_text_missed(ctx):
    _change(ctx, skip_doc='Natugu text 4')


def wrong_nothing(ctx):
    return h.no_plan()
