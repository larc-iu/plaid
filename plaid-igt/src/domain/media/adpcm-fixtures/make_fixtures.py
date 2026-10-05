"""Write the WAV fixtures the ADPCM decoder is tested against.

Encoding and the reference decode are libsndfile's (through the `soundfile`
package), so the decoder is checked against a trusted implementation and not
against itself. Run it from this directory:

    python make_fixtures.py

with `soundfile` importable. Each ADPCM file has a `.ref.wav` beside it: the
same file decoded by libsndfile to 16-bit PCM. The extensible files are the
plain ones with their `fmt ` chunk rewritten as WAVE_FORMAT_EXTENSIBLE, the
samples untouched, so their reference is the plain file's.
"""

import struct

import numpy as np
import soundfile as sf

RATE = 22050
FRAMES = 6700  # not a whole number of blocks, so the last block is partial


def signal(channels):
    t = np.arange(FRAMES) / RATE
    rng = np.random.default_rng(7)
    # A sweep with a loud burst and a silent stretch: the step size has to
    # climb, fall and climb again.
    sweep = 0.6 * np.sin(2 * np.pi * (200 + 3000 * t) * t)
    sweep[2000:2600] = 0.95 * np.sign(np.sin(2 * np.pi * 900 * t[2000:2600]))
    sweep[4000:4400] = 0
    sweep += 0.02 * rng.standard_normal(FRAMES)
    if channels == 1:
        return np.clip(sweep, -1, 1)
    other = 0.5 * np.sin(2 * np.pi * 330 * t) + 0.05 * rng.standard_normal(FRAMES)
    return np.clip(np.stack([sweep, other], axis=1), -1, 1)


def chunks(data):
    at, out = 12, []
    while at + 8 <= len(data):
        cid, size = data[at:at + 4], struct.unpack('<I', data[at + 4:at + 8])[0]
        out.append((cid, data[at + 8:at + 8 + size]))
        at += 8 + size + (size & 1)
    return out


def riff(chunk_list):
    body = b'WAVE'
    for cid, payload in chunk_list:
        body += cid + struct.pack('<I', len(payload)) + payload
        if len(payload) & 1:
            body += b'\0'
    return b'RIFF' + struct.pack('<I', len(body)) + body


def extensible(path, out):
    """The same file with its fmt chunk as WAVE_FORMAT_EXTENSIBLE."""
    data = open(path, 'rb').read()
    rewritten = []
    for cid, payload in chunks(data):
        if cid == b'fmt ':
            tag, ch, rate, avg, align, bits = struct.unpack('<HHIIHH', payload[:16])
            extra = payload[18:] if len(payload) > 18 else b''
            # IMA: extra is samplesPerBlock. MS: samplesPerBlock, then the
            # coefficient table, which the extensible form has no room for:
            # a decoder falls back to the seven standard pairs.
            samples_per_block = struct.unpack('<H', extra[:2])[0]
            guid = struct.pack('<H', tag) + bytes.fromhex('00000000001000800000aa00389b71')
            payload = struct.pack('<HHIIHH', 0xFFFE, ch, rate, avg, align, bits)
            payload += struct.pack('<HHI', 22, samples_per_block, 0) + guid
        rewritten.append((cid, payload))
    open(out, 'wb').write(riff(rewritten))


def main():
    for channels in (1, 2):
        name = 'mono' if channels == 1 else 'stereo'
        for subtype, stem in (('IMA_ADPCM', 'ima'), ('MS_ADPCM', 'ms')):
            path = f'{stem}-{name}.wav'
            sf.write(path, signal(channels), RATE, subtype=subtype, format='WAV')
            decoded, rate = sf.read(path, dtype='int16')
            sf.write(f'{stem}-{name}.ref.wav', decoded, rate, subtype='PCM_16', format='WAV')
        extensible(f'ima-{name}.wav', f'ima-{name}-ext.wav')
    extensible('ms-mono.wav', 'ms-mono-ext.wav')
    # Codings no browser plays and the decoder does not take.
    sf.write('gsm.wav', signal(1)[:3200], 8000, subtype='GSM610', format='WAV')
    sf.write('g721.wav', signal(1)[:3200], 8000, subtype='G721_32', format='WAV')
    sf.write('pcm.wav', signal(1)[:2000], RATE, subtype='PCM_16', format='WAV')


if __name__ == '__main__':
    main()
