import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Badge } from '@ui/components/ui/badge';
import { DataTable } from '@ui/components/ui/data-table';
import { UserAvatar } from '@ui/components/shared/UserAvatar';
import { timeAgo, fullTimestamp } from '@ui/utils/formatTime';
import { notifyError, humanizeError } from '@/utils/feedback';
import { AssistantMarkdown } from '@ui/components/assistant/AssistantMarkdown.jsx';
import { conversationToMarkdown } from '@ui/components/assistant/exportMarkdown.js';
import { IGT_ASSISTANT } from '../projects/assistant/adapter.js';
import { PLAIN_CITATIONS } from '@ui/components/assistant/plainCitations.js';

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

const ConversationDetail = ({ client, row, onBack }) => {
  const [markdown, setMarkdown] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    setMarkdown(null);
    setError(null);
    client.userData
      .get(row.userId, convKeyFor(row.app, row.projectId, row.convId))
      .then((entry) => {
        if (!live) return;
        const value = entry?.value || {};
        // The same rendering the owner's own export produces, so what an
        // operator reads is what the person had. `origin` is empty because
        // these links stay inside the app.
        setMarkdown(
          conversationToMarkdown({ display: value.display || [] }, row.meta, {
            origin: '',
            projectId: row.projectId,
            projectName: row.projectName,
            // Another app's citations are shown as the reference they
            // name: this app cannot draw its grid or link into its editor.
            adapter: row.app === OWN_APP ? IGT_ASSISTANT : PLAIN_CITATIONS,
          }),
        );
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

  return (
    <div className="flex flex-col gap-4">
      <Button variant="ghost" size="sm" className="self-start" onClick={onBack}>
        <ArrowLeft className="h-4 w-4" /> All conversations
      </Button>

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
          {row.model && (
            <>
              <span>·</span>
              <span>{row.model}</span>
            </>
          )}
        </p>
      </div>

      {error ? (
        <p className="text-sm text-muted-foreground">{error}</p>
      ) : markdown === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="rounded-lg border bg-card p-4">
          <AssistantMarkdown>{markdown}</AssistantMarkdown>
        </div>
      )}
    </div>
  );
};

export const AdminAssistant = ({ client }) => {
  const [entries, setEntries] = useState([]);
  const [users, setUsers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);

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
      notifyError(humanizeError(err, 'Failed to load conversations'), 'Error');
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
    const row = rows.find((r) => r.key === selected);
    if (row) {
      return <ConversationDetail client={client} row={row} onBack={() => setSelected(null)} />;
    }
  }

  const columns = [
    {
      key: 'title',
      label: 'Conversation',
      sort: (r) => r.title.toLowerCase(),
      render: (r) => (
        <button
          type="button"
          className="text-left font-medium hover:underline"
          onClick={() => setSelected(r.key)}
        >
          {r.title}
        </button>
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
          <span>{r.userName}</span>
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
          <Badge variant="outline">Deleted project</Badge>
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
      className: 'text-muted-foreground',
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
          r.title.toLowerCase().includes(q) ||
          r.userName.toLowerCase().includes(q) ||
          r.userId.toLowerCase().includes(q) ||
          r.projectName.toLowerCase().includes(q),
      }}
      noun="conversation"
      empty="No conversations."
      noMatch={(q) => `No conversations match “${q}”.`}
      loading={loading}
    />
  );
};
