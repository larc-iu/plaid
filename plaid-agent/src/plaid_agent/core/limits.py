"""The numbers both apps are held to.

Each of these was written twice, once per app, and a number with two homes
drifts: one app was raised and the other was not, and the difference showed up
as a tool behaving differently for no reason anyone could name. A number that
is about the HARNESS (what a tool result may cost, what the engine will
return, how much one reply may fetch) belongs here. A number that is about
what an app annotates stays in the app.
"""

# The most characters one tool result may be. Past it the result is cut and
# says so, because a model that is handed a hundred kilobytes of rows loses
# the thread of the question it asked.
MAX_RESULT_CHARS = 12000

# What the query engine will return before it stops. `group` is the backstop
# for grouped rows and `row` the hard cap for ids and entities. Both are high
# on purpose: an aggregate comes back unordered, so the whole group set has to
# arrive for the top of it to be the real top.
GROUP_LIMIT = 100000
ROW_LIMIT = 100000

# How many rows a read tool shows by default, and the most it will show when
# asked: (default, cap) for every tool BOTH apps offer. Written once per app
# they drifted apart for no reason anyone could name, so one tool answered with
# a hundred rows in one app and thirty in the other.
#
# The rule for the pair: the smaller default, the larger cap. Context is the
# scarce thing, so a tool asked for nothing in particular gives the short
# answer; and nothing is taken away, because the model can always ask for more.
READ_LIMITS = {
    'list_documents': (50, 500),
    'search': (30, 200),
    'frequency_list': (30, 1000),
    'worklist': (20, 500),
    'comments': (30, 200),
    'recent_changes': (20, 100),
    'query': (50, 500),
}

# What one reply's citations may cost. A citation is resolved against the
# documents the turn already read; past that it fetches, so the fetching is
# what needs a budget.
MAX_CITATIONS = 40       # citations resolved in one reply
MAX_FOCUS = 20           # marked items in one citation
CITE_DOC_BUDGET = 8      # documents one reply's citations may fetch that the turn did not read

# Documents one change over a scope may name. Past it the model goes in
# passes, because the plan is stored in the conversation record and the
# documents it pins are stored with it.
MAX_SCOPE_DOCS = 100

# Sentences one read_document call renders. The render also has a character
# budget and says which sentences it actually showed, so this is the ceiling
# rather than the promise.
MAX_SENTENCES_PER_READ = 40

# Documents the project overview names. The rest are in list_documents, which
# pages and filters, and the overview says so.
OVERVIEW_DOCS = 50

# Example lines a bulk answer shows before "… n more". Enough to see what the
# pattern did, few enough to leave room for the answer around it.
SAMPLE_LINES = 8
