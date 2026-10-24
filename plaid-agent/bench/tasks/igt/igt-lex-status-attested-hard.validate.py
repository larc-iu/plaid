import importlib.util
from pathlib import Path

import handwrite as h
import igtlib as L

_spec = importlib.util.spec_from_file_location(
    'status_setup', Path(__file__).with_name('igt-lex-status-attested-hard.setup.py'))
_setup = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_setup)


def _draft(ctx, labels):
    for lab in sorted(labels):
        L.patch_entry(ctx, lab, {'status': 'draft'})


def right(ctx):
    _draft(ctx, _setup.linked_labels(ctx) - set(_setup.PLANTED))


def wrong_overwrote(ctx):
    # Every linked item, the four that already had a status included.
    _draft(ctx, _setup.linked_labels(ctx))


def wrong_text_one_only(ctx):
    # The join made over one text: the items linked only from text 3 missed.
    from common import igt_values
    v = igt_values(L.raw(ctx, 'Gitksan text 1'))
    one = {f'{str(x).lower()}|{v.get(k[:-5] + ":Gloss") or ""}' for k, x in v.items() if k.endswith(':form')}
    _draft(ctx, one - set(_setup.PLANTED))


def wrong_unlinked_too(ctx):
    # The right result, and the unlinked items without a status marked too.
    items = L.vocab_items(ctx.client, ctx.project['vocabs'][0]['id'])
    linked = _setup.linked_labels(ctx)
    _draft(ctx, linked - set(_setup.PLANTED))
    _draft(ctx, {L.label(it) for it in items if L.label(it) not in linked
                 and not (it.get('metadata') or {}).get('status')})


def wrong_nothing(ctx):
    return h.no_plan()
