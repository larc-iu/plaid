import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Badge } from '@ui/components/ui/badge';
import { DataTable } from '@ui/components/shared/data-table';
import { Loading } from '@ui/components/shared/Loading.jsx';
import { UserAvatar } from '@ui/components/shared/UserAvatar';
import { timeAgo, fullTimestamp } from '@ui/lib/formatTime.js';
import { notifyError, humanizeError } from '@/utils/feedback';
import { Turn } from '@ui/components/assistant/Turn.jsx';
import { RetryLine } from '@ui/components/assistant/RetryLine.jsx';
import { UsageMeter } from '@ui/components/assistant/UsageMeter.jsx';
import { AssistantMark } from '@ui/components/assistant/PlaidMarks.jsx';
import { ExportMenu } from '@ui/components/assistant/ConversationList.jsx';
import { hidesStopped, retryNote } from '@ui/components/assistant/resume.js';
import { turnContext } from '@ui/components/assistant/transcript.js';
import { useReadable, useRounds } from '@ui/components/assistant/rounds.js';
import { closedTurns } from '@ui/components/assistant/projectReach.js';
import { latestUsage, totalSpend } from '@ui/components/assistant/usage.js';
import { IGT_ASSISTANT } from '../projects/assistant/adapter.js';
import { PLAIN_ASSISTANT } from '@ui/components/assistant/plainCitations.js';
import { textIncludes } from '@ui/domain/collation.js';

// Every assistant conversation on the instance. A conversation is private to
// the person who had it — it never appears in anyone else's sidebar — and an
// operator answering for what the assistant did on this server needs to read
// them anyway. So: an admin-only index of all of them, and each one whole.
//
// The record lives in the core user-data store under
// `<app>:assistant:<project>:meta:<id>` (the sidebar entry) and `...:conv:<id>`
// (the transcript). The index is one cross-account read of the meta keys; a
// transcript is fetched only when one is opened, because they are large.
//
// EVERY app's conversations, not just this one's: plaid-ud writes `ud:` keys
// against the same projects, and an admin looking for "who has been talking to
// an assistant" means all of them. A conversation from another app is shown
// and read, but its citations are not drawn the way that app would draw them
// and its rows do not link into an editor this app cannot address.
//
// Read-only, deliberately. The admin panels report and unblock; deleting
// somebody's conversation is neither, and the owner can already delete their
// own.

const META_PATTERN = '*:assistant:*:meta:*';

// This app's own tag, so a conversation it can render is told from one it
// cannot.
const OWN_APP = 'igt';

// `<app>:assistant:<project>:meta:<id>`. Both ids are UUIDs, so no segment can
// contain the separator.
const parseKey = (key) => {
  const parts = String(key).split(':');
  if (parts.length !== 5 || parts[1] !== 'assistant') return null;
  return { app: parts[0], projectId: parts[2], convId: parts[4] };
};

const convKeyFor = (app, projectId, convId) => `${app}:assistant:${projectId}:conv:${convId}`;

// The open conversation lives in the URL beside `?tab=assistant`, so its title
// is a real link: middle-click opens it in a new tab, and a pasted address
// opens it too. Every other param stays.
const PARAM = 'conversation';

const withConversation = (params, key) => {
  const next = new URLSearchParams(params);
  if (key) next.set(PARAM, key);
  else next.delete(PARAM);
  return { search: next.toString() };
};

const AllConversations = ({ to }) => (
  <Button asChild variant="ghost" size="sm" className="self-start">
    <Link to={to}>
      <ArrowLeft className="h-4 w-4" /> All conversations
    </Link>
  </Button>
);

// The conversation as its owner sees it in the chat, drawn by the chat's own
// `Turn`, and read-only: a plan shows its status and changes and offers no
// decision, there is no composer and no Retry, and nothing here writes to the
// owner's record or watches it (no settling, no pending clears, no polling).
// One read of the transcript when it opens, and that is all.
//
// Another app's conversation is drawn with PLAIN_ASSISTANT: its citations as
// the plain place they name, its plan rows by their stored labels, and no
// links into an editor this app cannot address.
const ConversationDetail = ({ client, row, backTo }) => {
  const [conv, setConv] = useState(null);
  const [error, setError] = useState(null);
  const adapter = row.app === OWN_APP ? IGT_ASSISTANT : PLAIN_ASSISTANT;

  useEffect(() => {
    let live = true;
    setConv(null);
    setError(null);
    client.userData
      .get(row.userId, convKeyFor(row.app, row.projectId, row.convId))
      .then((entry) => {
        if (!live) return;
        const value = entry?.value || {};
        setConv({
          id: row.convId,
          messages: value.messages || [],
          display: value.display || [],
        });
      })
      .catch((err) => {
        if (!live) return;
        setError(
          err?.status === 404
            ? 'The transcript is gone. Only the summary above remains.'
            : humanizeError(err, 'The conversation could not be read.'),
        );
      });
    return () => {
      live = false;
    };
  }, [client, row]);

  // How full the stored record is, as the assistant service wrote it on the
  // entry (`size`, the server's own count against its cap).
  const size = row.meta?.size;
  const record = size?.cap > 0 && size?.bytes > 0 ? { bytes: size.bytes, cap: size.cap } : null;

  const display = useMemo(() => conv?.display || [], [conv?.display]);
  // What a step opens to, read from the owner's store as the transcript is.
  const rounds = useRounds(client, row.userId, row.app, row.projectId, row.convId);
  // A turn that read a project nobody can open now (deleted) shows its step
  // labels only, the panel's rule, and so does every turn of a conversation
  // whose own project is gone.
  const readable = useReadable(client, display);
  const closedAt = useMemo(
    () =>
      closedTurns(
        display,
        (id) => !id || (id === row.projectId ? row.projectExists : !!readable?.has(id)),
      ),
    [display, row.projectId, row.projectExists, readable],
  );
  const usage = useMemo(() => latestUsage(conv?.display), [conv?.display]);
  const spend = useMemo(() => totalSpend(conv?.display), [conv?.display]);
  // The chat's own rule for the line under a turn with no answer, except that
  // a turn still marked as running is not called unanswered: its owner's page
  // may be waiting on it, and this one does not ask.
  const lastKind = display.at(-1)?.kind;
  const unanswered = !row.meta?.pending && (lastKind === 'user' || lastKind === 'error');

  return (
    <div className="flex flex-col gap-4">
      <AllConversations to={backTo} />

      <div>
        <h2 className="text-xl font-semibold">{row.title}</h2>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <span>{row.userName}</span>
          <span>·</span>
          {/* Only this app's own conversations link into its routes, the same
              rule the list column follows: a UD project has no page here. */}
          {row.projectExists && row.app === OWN_APP ? (
            <Link to={`/projects/${row.projectId}`} className="hover:underline">
              {row.projectName}
            </Link>
          ) : (
            <span>{row.projectName}</span>
          )}
          <span>·</span>
          <span title={fullTimestamp(row.updatedAt)}>{timeAgo(row.updatedAt)}</span>
        </p>
      </div>

      {error ? (
        <p className="text-sm text-muted-foreground">{error}</p>
      ) : conv === null ? (
        <Loading className="p-0" />
      ) : (
        <section className="flex min-w-0 flex-col rounded-lg border bg-card">
          <header className="flex min-h-14 flex-wrap items-center gap-2 border-b px-3 py-2 text-sm">
            <AssistantMark className="h-4 w-4 shrink-0" />
            {row.model && <span className="font-medium">{row.model}</span>}
            <div className="ml-auto flex items-center gap-2">
              <UsageMeter usage={usage} spend={spend} record={record} />
              {display.length > 0 && (
                <ExportMenu
                  conv={conv}
                  meta={row.meta}
                  projectId={row.projectId}
                  projectName={row.projectName}
                  adapter={adapter}
                  client={client}
                  owner={row.userId}
                  app={row.app}
                  appLabel={row.app === OWN_APP ? null : row.app}
                />
              )}
            </div>
          </header>
          <div className="px-4 py-4">
            <div className="mx-auto flex max-w-3xl flex-col gap-5">
              {display.length === 0 && (
                <p className="text-sm text-muted-foreground">No messages.</p>
              )}
              {display.map((d, i) =>
                unanswered &&
                hidesStopped(display, i) &&
                !d.steps?.length &&
                !d.partial &&
                !d.replyRound ? null : (
                  <Turn
                    key={i}
                    item={d}
                    projectId={row.projectId}
                    adapter={adapter}
                    rounds={!row.projectExists || closedAt.has(i) ? null : rounds}
                    hideLine={unanswered && hidesStopped(display, i)}
                    {...turnContext(display, i)}
                    homeName={row.projectName}
                    canWrite={false}
                    busy={false}
                    interrupted={!!d.interrupted}
                    applying={false}
                    readOnly
                  />
                ),
              )}
              {unanswered && <RetryLine note={retryNote(display, null)} />}
            </div>
          </div>
        </section>
      )}
    </div>
  );
};

export const AdminAssistant = ({ client }) => {
  const [entries, setEntries] = useState([]);
  const [users, setUsers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchParams] = useSearchParams();
  const selected = searchParams.get(PARAM);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [metas, userList, projectList] = await Promise.all([
        client.admin.userData({ pattern: META_PATTERN, includeValues: true }),
        client.users.list(),
        client.projects.list(),
      ]);
      setEntries(metas || []);
      setUsers(userList || []);
      setProjects(projectList || []);
    } catch (err) {
      console.error('Error loading conversations:', err);
      notifyError(humanizeError(err), 'Failed to load the conversations');
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(() => {
    const byUser = new Map(users.map((u) => [u.id, u]));
    const byProject = new Map(projects.map((p) => [p.id, p]));
    return entries.flatMap((entry) => {
      const parsed = parseKey(entry.key);
      if (!parsed) return [];
      const meta = entry.value || {};
      const user = byUser.get(entry.userId);
      const project = byProject.get(parsed.projectId);
      return [
        {
          key: entry.key,
          app: parsed.app,
          userId: entry.userId,
          user,
          userName: user?.displayName || entry.userId,
          projectId: parsed.projectId,
          projectExists: !!project,
          // A project can be deleted while the conversation about it stays in
          // its owner's store, so the name is not always there to look up.
          projectName: project?.name || 'Deleted project',
          convId: parsed.convId,
          meta,
          title: meta.title || 'Untitled',
          turns: typeof meta.turns === 'number' ? meta.turns : null,
          model: meta.model || null,
          // The row's own stamp, not the meta value's: it is what the store
          // recorded, and it is there even when the value is malformed.
          updatedAt: entry.updatedAt,
        },
      ];
    });
  }, [entries, users, projects]);

  if (selected) {
    const backTo = withConversation(searchParams, null);
    // The detail needs the index's row (who, which project, the summary), so
    // an address opened cold waits for the index.
    if (loading) return <Loading className="p-0" />;
    const row = rows.find((r) => r.key === selected);
    if (row) return <ConversationDetail client={client} row={row} backTo={backTo} />;
    return (
      <div className="flex flex-col gap-4">
        <AllConversations to={backTo} />
        <p className="text-sm text-muted-foreground">There is no conversation at this address.</p>
      </div>
    );
  }

  const columns = [
    {
      key: 'title',
      label: 'Conversation',
      sort: (r) => r.title.toLowerCase(),
      render: (r) => (
        <Link to={withConversation(searchParams, r.key)} className="font-medium hover:underline">
          {r.title}
        </Link>
      ),
    },
    {
      key: 'user',
      label: 'Person',
      sort: (r) => r.userName.toLowerCase(),
      render: (r) => (
        <div className="flex items-center gap-2">
          <UserAvatar
            client={client}
            userId={r.userId}
            displayName={r.user?.displayName}
            avatarHash={r.user?.avatarHash}
            className="h-6 w-6"
          />
          <span className="whitespace-nowrap">{r.userName}</span>
        </div>
      ),
    },
    {
      key: 'app',
      label: 'App',
      sort: (r) => r.app,
      render: (r) => <Badge variant={r.app === OWN_APP ? 'secondary' : 'outline'}>{r.app}</Badge>,
    },
    {
      key: 'project',
      label: 'Project',
      sort: (r) => r.projectName.toLowerCase(),
      // A project opens here only for this app's own conversations: the others
      // belong to an app whose routes this one does not know.
      render: (r) =>
        !r.projectExists ? (
          <Badge variant="outline" className="whitespace-nowrap">
            Deleted project
          </Badge>
        ) : r.app === OWN_APP ? (
          <Link to={`/projects/${r.projectId}`} className="hover:underline">
            {r.projectName}
          </Link>
        ) : (
          <span>{r.projectName}</span>
        ),
    },
    {
      key: 'turns',
      label: 'Turns',
      sort: (r) => r.turns,
      align: 'right',
      className: 'tabular-nums text-muted-foreground',
      headerClassName: 'w-20',
      render: (r) => (r.turns === null ? '—' : r.turns),
    },
    {
      key: 'model',
      label: 'Assistant',
      sort: (r) => (r.model || '').toLowerCase(),
      className: 'text-muted-foreground',
      render: (r) => r.model || '—',
    },
    {
      key: 'updated',
      label: 'Updated',
      sort: (r) => (r.updatedAt ? new Date(r.updatedAt).getTime() : null),
      className: 'whitespace-nowrap text-muted-foreground',
      render: (r) => <span title={fullTimestamp(r.updatedAt)}>{timeAgo(r.updatedAt)}</span>,
    },
  ];

  return (
    <DataTable
      rows={rows}
      columns={columns}
      rowKey={(r) => r.key}
      id="admin-assistant"
      defaultSort={{ key: 'updated', dir: 'desc' }}
      search={{
        placeholder: 'Search conversations…',
        match: (r, q) =>
          textIncludes(r.title, q) ||
          textIncludes(r.userName, q) ||
          textIncludes(r.userId, q) ||
          textIncludes(r.projectName, q),
      }}
      noun="conversation"
      empty="No conversations."
      noMatch={(q) => `No conversations match “${q}”.`}
      loading={loading}
    />
  );
};
