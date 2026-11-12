import igt_job_hand as H
import igtlib as L

FORM = 'я'


def setup(ctx):
    """Every я of the project left blank but one, in the last document, as a
    person analysed it."""
    names = [d['name'] for d in ctx.project['documents']]
    kept = False
    for name in reversed(names):
        for a, _ in H.words(ctx, name, form=FORM):
            if not kept and name not in ('Lezgi text 1', 'Lezgi text 2'):
                kept = True
                continue
            L.strip_analysis(ctx, name, a)
    assert kept, 'a person\'s analysis of я stays'
