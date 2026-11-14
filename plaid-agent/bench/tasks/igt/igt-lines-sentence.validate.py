import handwrite as h
import igt_job_hand as H
import igtlib as L

DOC = 'Gitksan text 2'
FORMS = "ii ji-da hlen-txw-'y dim ii gipaykw bisde'y"
GLOSS = "CCNJ IRR-SPT move-PASS-1SG.II PROSP CCNJ fly grouse"


def _morphs():
    """{word address: [(form, gloss), ...]} of sentence 14 as the lines give it."""
    return {f's14.w{i}': list(zip(f.split('-'), g.split('-')))
            for i, (f, g) in enumerate(zip(FORMS.split(), GLOSS.split()), 1)}


def _write(ctx, morphs, link=True):
    for w, ms in morphs.items():
        L.analyze(ctx, DOC, w, ms)
    if link:
        by = {}
        for w, ms in morphs.items():
            for k, (f, g) in enumerate(ms, 1):
                by.setdefault(f'{f}|{g}', []).append(f'{w}.m{k}')
        for lab, refs in by.items():
            L.link(ctx, DOC, refs, lab)


def _run4(ctx):
    """Run4's mistake as the model made it: every morpheme of the sentence
    on its first word."""
    return {'document': DOC, 'ref': 's14', 'forms': FORMS.replace(' ', '-'), 'gloss': GLOSS.replace(' ', '-')}


def right(ctx):
    _write(ctx, _morphs())


def right_through_the_tool(ctx):
    # The tool itself, its plan applied as an approval applies it.
    H.staged(ctx, ctx.user, [('analyze_sentence', {'document': DOC, 'ref': 's14', 'forms': FORMS,
                                                   'gloss': GLOSS})], stamp_mode='verified')


def wrong_run4_refused(ctx):
    # The tool refuses the whole sentence on its first word and stages
    # nothing, so the plan applied writes nothing at all.
    said, ops = H.tool_answer(ctx, ctx.user, 'analyze_sentence', _run4(ctx))
    assert said.startswith('Error: s14 not staged: forms has 1 word, s14 has 7') and not ops, said


def wrong_run4_written(ctx):
    # The same mistake had it been written: the checker sees it as wrong.
    ms = [m for w in _morphs().values() for m in w]
    L.analyze(ctx, DOC, 's14.w1', ms)


def wrong_unlinked(ctx):
    _write(ctx, _morphs(), link=False)


def wrong_new_entry(ctx):
    # A new entry made where one fits.
    _write(ctx, {w: ms for w, ms in _morphs().items() if w != 's14.w6'})
    L.analyze(ctx, DOC, 's14.w6', [('gipaykw', 'fly')])
    made = L.create_entry(ctx, 'gipaykw', {'gloss': 'fly'})
    ids = L.ids_by_address(L.raw(ctx, DOC))
    ctx.user.vocab_links.bulk_create([{'vocab_item': made['id'], 'tokens': [ids['s14.w6.m1']],
                                       'metadata': L.stamp()}])


def wrong_nothing(ctx):
    return h.no_plan()
