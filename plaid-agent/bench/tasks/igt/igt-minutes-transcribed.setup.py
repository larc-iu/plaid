import io
import wave

import common as c
import igtlib as L

SEGMENT_S = 7
RECORDING_S = 300


def silence(seconds):
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(1)
        w.setframerate(8000)
        w.writeframes(b'\x80' * (8000 * seconds))
    return buf.getvalue()


def setup(ctx):
    """A time-alignment layer, as the project setup makes one, with a segment
    over each sentence of Lezgi text 1 (sentence i from 10 i to 10 i + 7 s),
    and the text's recording."""
    d = L.raw(ctx, 'Lezgi text 1')
    tl = d['text_layers'][0]
    # The igt project setup already made an empty "Time Alignment" layer
    # (role time-alignment): use it. A second layer with the same role is
    # one the assistant never reads (it takes the first).
    have = [t for t in tl['token_layers'] if ((t.get('config') or {}).get('plaid') or {}).get('role') == 'time-alignment']
    if have:
        lid = have[0]['id']
    else:
        layer = ctx.client.token_layers.create(tl['id'], 'Time Alignment', overlap_mode='non-overlapping')
        lid = layer['id'] if isinstance(layer, dict) else layer
        ctx.client.token_layers.set_config(lid, 'plaid', 'role', 'time-alignment')
    sents = c._sorted(c._layer(tl, 'sentence')['tokens'])
    ctx.client.tokens.bulk_create([
        {'token_layer_id': lid, 'text': tl['text']['id'], 'begin': s['begin'], 'end': s['end'],
         'metadata': {'timeBegin': 10.0 * i, 'timeEnd': 10.0 * i + SEGMENT_S}}
        for i, s in enumerate(sents)])
    ctx.client.documents.upload_media(L.doc_of(ctx, 'Lezgi text 1')['id'],
                                      ('lezgi-text-1.wav', silence(RECORDING_S), 'audio/wav'))
    # The assistant reads the first time-alignment layer of the project: it
    # must be the one that now holds the 20 segments.
    from plaid_client.roles import find_by_role
    tls = ctx.client.projects.get(ctx.project['id'])['text_layers'][0]['token_layers']
    first = find_by_role(tls, 'time-alignment')
    assert first and first['id'] == lid, 'the segments are not on the project\'s first time-alignment layer'
    L.snap(ctx)
