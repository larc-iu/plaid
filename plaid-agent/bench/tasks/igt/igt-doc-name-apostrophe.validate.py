import handwrite as h
import igtlib as L


def right(ctx):
    L.set_field(ctx, 'Gitksan text 2', {'s3.w5.m1': 'go.toward', 's3.w9.m1': 'go.toward'})


def wrong_part_one(ctx):
    # The first document whose name starts the same way.
    L.set_field(ctx, 'Gitksan text 1', {'s3.w2.m1': 'go.toward', 's3.w7.m1': 'go.toward'})


def wrong_one_of_two(ctx):
    L.set_field(ctx, 'Gitksan text 2', {'s3.w5.m1': 'go.toward'})


def wrong_every_hogwin(ctx):
    # Both sentences.
    L.set_field(ctx, 'Gitksan text 2', {'s3.w5.m1': 'go.toward', 's3.w9.m1': 'go.toward'})
    L.set_field(ctx, 'Gitksan text 1', {'s3.w2.m1': 'go.toward', 's3.w7.m1': 'go.toward'})


def wrong_nothing(ctx):
    return h.no_plan()
