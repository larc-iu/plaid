import igt_job_hand as H
import igtlib as L

DOC = 'Lezgi text 4'


def setup(ctx):
    """Of Lezgi text 4's two я, the first glossed COP by a person, the other
    left "was" as imported: people analysed я two ways in it."""
    words = H.words(ctx, DOC, form='я')
    assert len(words) >= 2, words
    L.set_field(ctx, DOC, {f'{words[0][0]}.m1': 'COP'}, verified=False)
    L.snap(ctx)
