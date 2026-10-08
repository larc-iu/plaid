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

# What a RENDER may cost, which is the result's budget less room for the
# header the tool writes around it (which sentences were shown, where to
# continue). The render is given this and the header is added afterwards, so
# the two together stay inside MAX_RESULT_CHARS.
RENDER_HEADER_ROOM = 100
RENDER_BUDGET = MAX_RESULT_CHARS - RENDER_HEADER_ROOM

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
    'read_file': (40, 500),
}

# How the audit log is walked: entries per page, newest first, and how many
# pages a filtered read will go back through before it gives up. The log of a
# corpus is long (one real project's is six thousand entries and eight
# megabytes with their ops), so a read stops as soon as it has the rows it was
# asked for.
AUDIT_PAGE = 200
AUDIT_MAX_PAGES = 10

# How many parsed documents this process keeps, across every turn and every
# user of it. Documents are what a corpus walk re-reads most, and a parsed one
# is large, so this is a memory budget as much as a hit rate: raising it is
# how an operator with room trades memory for round trips.
DOC_CACHE_SIZE = 400

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

# Characters of guideline bodies that go into the system prompt whole. Past
# it only the PINNED ones are inlined and the rest are left to read_guideline.
# Characters and not tokens: nothing in this package counts tokens, on purpose
# (see the note in core/conversation.py about what the server actually
# measures), and a per-provider-wrong token count would be worse than a plain
# length. About four thousand words, which is a whole small manual, because
# the case worth optimizing for is the project whose manual fits.
GUIDELINES_INLINE_CHARS = 24000

# Example lines a bulk answer shows before "… n more". Enough to see what the
# pattern did, few enough to leave room for the answer around it.
SAMPLE_LINES = 8

# Documents a bulk answer counts by name before "and n more documents". The
# model once invented a per-document breakdown when it was given none.
BY_DOCUMENT_LINES = 10

# Projects one conversation may read, the one it belongs to included. Each
# other project costs a paragraph of the system prompt on every turn, so this
# bounds the prompt as much as the reads. Advertised to the browser as
# ``extras.max_projects``, so the control that adds a project stops at the
# same number the service holds to.
MAX_PROJECTS = 5

# Characters of the system prompt one other project's paragraph may take. Past
# it the paragraph is cut and says where the rest is.
OTHER_PROJECT_CHARS = 3000

# Sentences one document's record in a plan may pin by fingerprint. A plan is
# stored in the conversation record, and each pinned sentence costs about
# seventy bytes there, so a plan reaching more of a document than this is
# pinned to the whole document by its version instead, as every plan was
# before sentences were pinned. An edit anywhere in it then refuses the plan.
PIN_SENTENCES_MAX = 200

# Sentences one plan may pin by fingerprint across all its documents, about
# seventy kilobytes of the record. A plan of a few thousand per-word changes
# over many documents would otherwise store a pin per sentence beside a
# thousand-odd changes, and a record past its budget is refused whole. Past
# it, the documents pinning the most are pinned by their version instead.
PIN_SENTENCES_PLAN_MAX = 1000

# The share of the model's context window the stored transcript may fill
# between turns. The rest is for the system prompt and tool schemas (measured
# and taken off separately), the next message, and the tool results the next
# turn piles up before it answers. The record's own size limit is far larger
# than any window, so this, and not that, is what keeps a long thread
# sendable.
TRANSCRIPT_WINDOW_SHARE = 0.8

# Changes one plan may make once its rules are expanded (a rule stored as one
# change counts every change it stands for), asked when a change is staged and
# again when the plan is approved. About thirteen seconds of bulk updates at
# the measured 6,107 values in 3.9 s (Luke, 2026-10-08).
PLAN_MAX_CHANGES = 20000

# Documents one plan may reach. Approval locks each of them, one call each,
# and holds every lock until the last write (Luke, 2026-10-08).
PLAN_MAX_DOCUMENTS = 500
