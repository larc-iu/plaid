import igt_job_hand as H
import igtlib as L

DOC = 'Gitksan text 2'


def setup(ctx):
    """Sentences 16 to 20 of Gitksan text 2 left blank: their words' analyses go."""
    for a, _ in H.words(ctx, DOC, sentences=range(16, 21)):
        L.strip_analysis(ctx, DOC, a)
