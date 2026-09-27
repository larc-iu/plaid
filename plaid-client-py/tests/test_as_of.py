"""Only the document and vocabulary reads and restores take ``?as-of=``. The
server answers 400 to it on every other route, so a method elsewhere that
offered ``as_of`` could only fail."""

import inspect
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import client as real

TAKES_AS_OF = {'DocumentsResource.get', 'DocumentsResource.restore',
               'VocabLayersResource.get', 'VocabLayersResource.get_item_at',
               'VocabLayersResource.restore_item'}


def test_no_method_but_the_document_and_vocabulary_reads_and_restores_take_as_of():
    offenders = []
    for cls_name, cls in vars(real).items():
        if not inspect.isclass(cls) or cls.__module__ != real.__name__:
            continue
        for name, fn in vars(cls).items():
            if not callable(fn) or f'{cls_name}.{name}' in TAKES_AS_OF:
                continue
            if 'as_of' in inspect.signature(fn).parameters:
                offenders.append(f'{cls_name}.{name}')
    assert offenders == []
