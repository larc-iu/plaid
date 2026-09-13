"""The two pieces of reading a project that are the same whatever is annotated.

An app's own project module owns everything else: which layers it looks for,
what it calls them, and what a loaded document is shaped like.
"""

from typing import Optional, Tuple


def find_layer(text_layers, token_layer_id: Optional[str]) -> Tuple[Optional[dict], Optional[dict]]:
    """(text layer, token layer) for a token layer id, out of a raw project or
    document body. (None, None) when the project has no such layer."""
    for tl in text_layers or []:
        for tk in tl.get('token_layers') or []:
            if tk['id'] == token_layer_id:
                return tl, tk
    return None, None


def word_ref(sentence, word) -> str:
    """How a word is addressed in both apps: ``s3.w2``.

    Positional, never an id: the model reads these out of a rendered document
    and writes them back, and an id it has never seen is one it can invent.
    """
    return f's{sentence.index}.w{word.index}'
