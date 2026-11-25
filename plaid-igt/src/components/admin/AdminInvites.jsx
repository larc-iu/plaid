import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link2, Copy, Check } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Input } from '@ui/components/ui/input';
import { Label } from '@ui/components/ui/label';
import { Badge } from '@ui/components/ui/badge';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@ui/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@ui/components/ui/dialog';
import { DataTable } from '@ui/components/shared/data-table';
import { timeAgo, fullTimestamp } from '@ui/lib/formatTime.js';
import { notifySuccess, notifyError, humanizeError } from '@/utils/feedback';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { InviteStatusBadge } from '@ui/components/shared/InviteStatusBadge.jsx';
import { inviteLinkFor, GRANT_ROLES, cap, inviteRevocable } from '@ui/domain/invites.js';
import { ProjectLink } from './ProjectLink';
import { ROLE_HINTS } from '@/domain/roleGrants.js';
import { textIncludes } from '@ui/domain/collation.js';
import { countOf } from '@ui/lib/plural.js';
import { copyText } from '@ui/lib/download.js';

// Every invite on the server, whoever minted it. A project's own tab shows
// that project's links; this is the one place an admin can see an admin grant
// somebody else handed out, and the one place to mint a link that grants no
// project.

const EMPTY_BATCH = { uses: '20', role: 'writer', ttlDays: '30', note: '', projectId: '' };

// The project choice for links that create an account and grant nothing else.
const NO_PROJECT = 'none';

// The minted link, shown once. Nothing stores a code, so this is the only
// chance to capture it.
const LinkResult = ({ link, onClose }) => {
  const [copied, setCopied] = useState(false);
  const text = link ? inviteLinkFor(link.code) : '';

  const copy = async () => {
    if (!(await copyText(text, 'Select the link and copy it by hand.'))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={Boolean(link)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Link created</DialogTitle>
          <DialogDescription>
            Copy it now. It cannot be shown again. It creates up to{' '}
            {countOf(link?.maxUses ?? 0, 'account')}.
          </DialogDescription>
        </DialogHeader>
        <Input
          readOnly
          value={text}
          aria-label="Invite link"
          className="font-mono text-xs"
          onFocus={(e) => e.target.select()}
        />
        <DialogFooter className="sm:justify-between">
          <Button variant="outline" onClick={copy}>
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            Copy
          </Button>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export const AdminInvites = ({ client }) => {
  const confirm = useConfirm();
  const [invites, setInvites] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  // A list that could not be read is not an empty one.
  const [loadFailed, setLoadFailed] = useState(false);
  const [status, setStatus] = useState('all');
  const [batchOpen, setBatchOpen] = useState(false);
  const [batch, setBatch] = useState(EMPTY_BATCH);
  const [minting, setMinting] = useState(false);
  const [minted, setMinted] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rows, projectList] = await Promise.all([
        client.invites.list({ all: true }),
        client.projects.list(),
      ]);
      setInvites(rows || []);
      setProjects(projectList || []);
      setLoadFailed(false);
    } catch (err) {
      console.error('Error loading invites:', err);
      setLoadFailed(true);
      notifyError(humanizeError(err), 'Failed to load the invitations');
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    load();
  }, [load]);

  const projectName = useCallback(
    (id) => projects.find((p) => p.id === id)?.name || id || '',
    [projects],
  );

  // Only the status filter lives here. The text search and the ordering are
  // the table's, like every other list.
  const rows = useMemo(
    () => (status === 'all' ? invites : invites.filter((i) => i.status === status)),
    [invites, status],
  );

  const mintBatch = async () => {
    const maxUses = Number(batch.uses);
    if (batch.uses === '' || !Number.isInteger(maxUses) || maxUses < 1 || maxUses > 200) {
      notifyError('Between 1 and 200.', 'Check the number of uses');
      return;
    }
    // Blank or 0 must not fall through to the server's default.
    const ttlDays = Number(batch.ttlDays);
    if (batch.ttlDays === '' || !Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 365) {
      notifyError('Between 1 and 365.', 'Check the expiry');
      return;
    }
    if (!batch.projectId) {
      notifyError('Choose a project, or No project.', 'Project required');
      return;
    }
    const grant =
      batch.projectId === NO_PROJECT ? {} : { projectId: batch.projectId, projectRole: batch.role };
    setMinting(true);
    try {
      const inv = await client.invites.create({
        ...grant,
        ttlDays,
        maxUses,
        note: batch.note || undefined,
      });
      setMinted({ code: inv.code, maxUses });
      setBatchOpen(false);
      setBatch(EMPTY_BATCH);
      await load();
    } catch (err) {
      console.error('Error minting invite:', err);
      notifyError(humanizeError(err), 'Failed to create the link');
    } finally {
      setMinting(false);
    }
  };

  const revoke = async (invite) => {
    const ok = await confirm({
      title: 'Revoke this link?',
      description: `${invite.note || 'The link'} stops working immediately. Accounts already created keep their access.`,
      confirmLabel: 'Revoke',
      destructive: true,
    });
    if (!ok) return;
    try {
      await client.invites.revoke(invite.id);
      notifySuccess('Link revoked');
      await load();
    } catch (err) {
      notifyError(humanizeError(err), 'Failed to revoke the invitation');
    }
  };

  const columns = [
    {
      key: 'note',
      label: 'Note',
      sort: (i) => (i.note || '').toLowerCase(),
      render: (i) => i.note || <span className="text-muted-foreground">Untitled</span>,
    },
    {
      key: 'grants',
      label: 'Grants',
      sort: (i) => (i.grantAdmin ? 'admin' : projectName(i.projectId).toLowerCase()),
      render: (i) =>
        i.kind === 'password-reset' ? (
          <span className="text-muted-foreground">Password reset for {i.targetUserId}</span>
        ) : (
          <span className="flex flex-wrap items-center gap-1">
            {i.grantAdmin && <Badge variant="destructive">Admin</Badge>}
            {i.projectId && (
              <ProjectLink
                project={projects.find((p) => p.id === i.projectId) ?? { id: i.projectId }}
                className="hover:underline"
              >
                {projectName(i.projectId)}
              </ProjectLink>
            )}
            {i.projectRole && <span className="text-muted-foreground">{i.projectRole}</span>}
            {!i.grantAdmin && !i.projectId && (
              <span className="text-muted-foreground">Account only</span>
            )}
          </span>
        ),
    },
    {
      key: 'createdBy',
      label: 'Created by',
      sort: (i) => (i.createdBy || '').toLowerCase(),
      className: 'text-muted-foreground',
      render: (i) => i.createdBy,
    },
    {
      key: 'uses',
      label: 'Uses',
      sort: (i) => i.uses,
      align: 'right',
      className: 'tabular-nums',
      render: (i) => `${i.uses} / ${i.maxUses}`,
    },
    {
      key: 'expires',
      label: 'Expires',
      sort: (i) => (i.expiresAt ? new Date(i.expiresAt).getTime() : null),
      className: 'text-muted-foreground',
      render: (i) => <span title={fullTimestamp(i.expiresAt)}>{timeAgo(i.expiresAt)}</span>,
    },
    {
      key: 'status',
      label: 'Status',
      sort: (i) => i.status,
      render: (i) => <InviteStatusBadge status={i.status} />,
    },
    {
      key: 'actions',
      label: '',
      headerClassName: 'w-20',
      align: 'right',
      render: (i) =>
        inviteRevocable(i.status) ? (
          <Button size="sm" variant="ghost" onClick={() => revoke(i)}>
            Revoke
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(i) => i.id}
        id="admin-invites"
        defaultSort={{ key: 'expires', dir: 'desc' }}
        search={{
          placeholder: 'Search invites\u2026',
          match: (i, q) =>
            textIncludes(i.note || '', q) ||
            textIncludes(i.createdBy || '', q) ||
            textIncludes(projectName(i.projectId), q),
        }}
        noun="invite"
        showCount={!loadFailed}
        empty={loadFailed ? 'Not loaded.' : 'No invites.'}
        loading={loading}
        actions={
          <>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any status</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="used">Used</SelectItem>
                <SelectItem value="expired">Expired</SelectItem>
                <SelectItem value="revoked">Revoked</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" onClick={() => setBatchOpen(true)}>
              <Link2 className="h-4 w-4" /> Create link
            </Button>
          </>
        }
      />

      <Dialog open={batchOpen} onOpenChange={setBatchOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create link</DialogTitle>
            <DialogDescription>
              One link that creates as many accounts as it has uses.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-uses">Uses</Label>
              <Input
                id="invite-uses"
                type="number"
                min="1"
                max="200"
                value={batch.uses}
                onChange={(e) => setBatch({ ...batch, uses: e.target.value })}
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-project">Project</Label>
              <Select
                value={batch.projectId}
                onValueChange={(v) => setBatch({ ...batch, projectId: v })}
              >
                <SelectTrigger id="invite-project">
                  <SelectValue placeholder="Choose a project" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_PROJECT}>No project</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {batch.projectId !== NO_PROJECT && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="invite-role">Role</Label>
                <Select value={batch.role} onValueChange={(v) => setBatch({ ...batch, role: v })}>
                  <SelectTrigger id="invite-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {GRANT_ROLES.map((r) => (
                      <SelectItem key={r} value={r} hint={ROLE_HINTS[r]}>
                        {cap(r)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-ttl">Expires in (days)</Label>
              <Input
                id="invite-ttl"
                type="number"
                min="1"
                max="365"
                value={batch.ttlDays}
                onChange={(e) => setBatch({ ...batch, ttlDays: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-label">Label</Label>
              <Input
                id="invite-label"
                placeholder="Field methods Fall 2026"
                value={batch.note}
                onChange={(e) => setBatch({ ...batch, note: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchOpen(false)} disabled={minting}>
              Cancel
            </Button>
            <Button onClick={mintBatch} disabled={minting}>
              {minting ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <LinkResult link={minted} onClose={() => setMinted(null)} />
    </div>
  );
};
