import igtlib as L

BLANKS = {'Gitksan text 1': ['s1.w2.m1', 's4.w8.m1'],     # yukw
          'Gitksan text 2': ['s11.w2.m1', 's5.w2.m1'],    # yukw, 'nii
          'Gitksan text 3': ['s1.w1.m1']}                 # 'nii


def setup(ctx):
    for doc, refs in BLANKS.items():
        L.set_field(ctx, doc, {r: None for r in refs}, verified=False)
    L.snap(ctx)
