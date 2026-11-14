import handwrite as h
import igt_job_hand as H
import igtlib as L

DOC = 'Gitksan text 2'
FORMS = "ii ji-da hlen-txw-'y dim ii gipaykw bisde'y"
GLOSS = "CCNJ IRR-SPT move-PASS-1SG.II PROSP CCNJ fly grouse"


def _items():
    """The lines as the tool takes them, one "FORMS GLOSS" item per word."""
    return [f"{f} {g}" for f, g in zip(FORMS.split(), GLOSS.split())]
NEW = [('gipaykw', 'fly'), ("bisde'y", 'grouse')]


def _morphs():
    return {f's14.w{i}': list(zip(f.split('-'), g.split('-')))
            for i, (f, g) in enumerate(zip(FORMS.split(), GLOSS.split()), 1)}


def _write(ctx, new=NEW, status=None):
    made = {}
    for f, g in new:
        made[(f, g)] = L.create_entry(ctx, f, {'gloss': g, **({'status': status} if status else {})})['id']
    morphs = _morphs()
    for w, ms in morphs.items():
        L.analyze(ctx, DOC, w, ms)
    ids = L.ids_by_address(L.raw(ctx, DOC))
    by = {}
    for w, ms in morphs.items():
        for k, (f, g) in enumerate(ms, 1):
            if (f, g) in made:
                ctx.user.vocab_links.bulk_create([{'vocab_item': made[(f, g)], 'tokens': [ids[f'{w}.m{k}']],
                                                   'metadata': L.stamp()}])
            elif (f, g) not in NEW:
                by.setdefault(f'{f}|{g}', []).append(f'{w}.m{k}')
    for lab, refs in by.items():
        L.link(ctx, DOC, refs, lab)


def right(ctx):
    _write(ctx)


def right_with_draft_status(ctx):
    _write(ctx, status='draft')


def right_through_the_tool(ctx):
    H.staged(ctx, ctx.user, [('analyze_sentence', {'document': DOC, 'new_entries': True, 'sentences': [
        {'ref': 's14', 'words': _items()}]})], stamp_mode='verified')


def wrong_run4_refused(ctx):
    said, ops = H.tool_answer(ctx, ctx.user, 'analyze_sentence', {
        'document': DOC, 'new_entries': True, 'sentences': [{'ref': 's14', 'words': [
            FORMS.replace(' ', '-') + ' ' + GLOSS.replace(' ', '-')]}]})
    assert said.startswith('Error: s14 not staged: words has 1 item, s14 has 7 words') and not ops, said


def wrong_no_drafts(ctx):
    # The two left unlinked, no entry made.
    _write(ctx, new=[])


def wrong_one_draft(ctx):
    _write(ctx, new=NEW[:1])


def wrong_nothing(ctx):
    return h.no_plan()
