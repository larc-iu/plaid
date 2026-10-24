"""Write the first N sentences of a CoNLL-U file as K documents of N/K
sentences each: OUTDIR/<prefix>-1.conllu ... Sentences are kept whole,
comments included.

    python conllu_slice.py SRC OUTDIR PREFIX --sentences 60 --docs 3
"""
import argparse
from pathlib import Path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('outdir')
    ap.add_argument('prefix')
    ap.add_argument('--sentences', type=int, default=60)
    ap.add_argument('--docs', type=int, default=3)
    a = ap.parse_args()
    blocks, cur = [], []
    with open(a.src, encoding='utf-8') as f:
        for line in f:
            if line.strip() == '':
                if cur:
                    blocks.append(cur)
                    cur = []
                    if len(blocks) >= a.sentences:
                        break
                continue
            cur.append(line.rstrip('\n'))
    if cur and len(blocks) < a.sentences:
        blocks.append(cur)
    per = -(-len(blocks) // a.docs)
    out = Path(a.outdir)
    out.mkdir(parents=True, exist_ok=True)
    for k in range(a.docs):
        chunk = blocks[k * per:(k + 1) * per]
        if not chunk:
            break
        (out / f'{a.prefix}-{k + 1}.conllu').write_text(
            ''.join('\n'.join(b) + '\n\n' for b in chunk), encoding='utf-8')
        print(out / f'{a.prefix}-{k + 1}.conllu', len(chunk))


if __name__ == '__main__':
    main()
