"""The three texts renamed with a curly apostrophe and a double space, as an
imported file name may leave them. The checker and the task's `where` go by
id, so the manifest's names still name them here."""
import igtlib as L

NAMES = {'Gitksan text 1': 'Man’s hunting story:  part 1',
         'Gitksan text 2': 'Man’s hunting story:  part 2',
         'Gitksan text 3': 'Man’s hunting story:  part 3'}


def setup(ctx):
    for old, new in NAMES.items():
        ctx.client.documents.update(L.doc_of(ctx, old)['id'], new)
    L.snap(ctx)
