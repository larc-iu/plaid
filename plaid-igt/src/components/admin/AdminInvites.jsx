import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Link2, Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { DataTable } from '@/components/ui/data-table';
import { timeAgo, fullTimestamp } from '@/utils/formatTime';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { useConfirm } from '@/components/shared/ConfirmProvider';
import { inviteLinkFor } from '../projects/ProjectInvites';

// Every invite on the server, whoever minted it. A project's own tab shows
// that project's links; this is the one place an admin can see an admin grant
// somebody else handed out, and the one place to mint a set of links at once.

const STATUS_VARIANT = {
  active: 'default',
  used: 'secondary',
  expired: 'secondary',
  revoked: 'outline',
};

const EMPTY_BATCH = { count: '20', role: 'writer', ttlDays: '30', note: '', projectId: '' };

// Minted links, shown once. Nothing stores a code, so this list is the only
// chance to capture them.
const BatchResult = ({ links, onClose }) => {
  const [copied, setCopied] = useState(false);
  const text = links.map((l) => `${l.note}\t${inviteLinkFor(l.code)}`).join('\n');

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      notifyError('Could not copy. Select the links and copy them manually.', 'Copy failed');
    }
  };

  return (
    <Dialog open={links.length > 0} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{links.length} links created</DialogTitle>
          <DialogDescription>
            Copy these now. They are not stored, so they cannot be shown again.
          </DialogDescription>
        </DialogHeader>
        <textarea
          readOnly
          value={text}
          rows={Math.min(14, links.length + 1)}
          className="w-full rounded-md border bg-muted p-2 font-mono text-xs"
          onFocus={(e) => e.target.select()}
        />
        <DialogFooter className="sm:justify-between">
          <Button variant="outline" onClick={copyAll}>
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            Copy all
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
  const [status, setStatus] = useState('all');
  const [batchOpen, setBatchOpen] = useState(false);
  const [batch, setBatch] = useState(EMPTY_BATCH);
  const [minting, setMinting] = useState(false);
  const [minted, setMinted] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rows, projectList] = await Promise.all([
        client.invites.list({ all: true }),
        client.projects.list(),
      ]);
      setInvites(rows || []);
      setProjects(projectList || []);
    } catch (err) {
      console.error('Error loading invites:', err);
      notifyError(err.message || 'Failed to load invites', 'Error');
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
    const count = Number(batch.count);
    if (!Number.isInteger(count) || count < 1 || count > 200) {
      notifyError('Between 1 and 200.', 'Check the number of links');
      return;
    }
    if (!batch.projectId) {
      notifyError('Choose the project the links grant access to.', 'Project required');
      return;
    }
    setMinting(true);
    const links = [];
    try {
      for (let i = 0; i < count; i += 1) {
        const note = batch.note ? `${batch.note} ${i + 1}` : `Link ${i + 1}`;
        // One single-use link each rather than one link with many uses: the
        // notes let a person be matched to the link they were handed.
        const inv = await client.invites.create({
          projectId: batch.projectId,
          projectRole: batch.role,
          ttlDays: Number(batch.ttlDays) || undefined,
          note,
        });
        links.push({ note, code: inv.code });
      }
      setMinted(links);
      setBatchOpen(false);
      setBatch(EMPTY_BATCH);
      await load();
    } catch (err) {
      console.error('Error minting invites:', err);
      notifyError(
        `${links.length} of ${count} created before it failed. ${err.message || ''}`.trim(),
        'Error',
      );
      if (links.length) setMinted(links);
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
      notifySuccess('Link revoked', 'Revoked');
      await load();
    } catch (err) {
      notifyError(err.message || 'Failed to revoke', 'Error');
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
              <Link to={`/projects/${i.projectId}`} className="hover:underline">
                {projectName(i.projectId)}
              </Link>
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
      render: (i) => <Badge variant={STATUS_VARIANT[i.status] || 'secondary'}>{i.status}</Badge>,
    },
    {
      key: 'actions',
      label: '',
      headerClassName: 'w-20',
      align: 'right',
      render: (i) =>
        i.status === 'active' ? (
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
            (i.note || '').toLowerCase().includes(q) ||
            (i.createdBy || '').toLowerCase().includes(q) ||
            projectName(i.projectId).toLowerCase().includes(q),
        }}
        noun="invite"
        empty="No invites."
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
              </SelectContent>
            </Select>
            <Button size="sm" onClick={() => setBatchOpen(true)}>
              <Link2 className="h-4 w-4" /> Create links
            </Button>
          </>
        }
      />

      <Dialog open={batchOpen} onOpenChange={setBatchOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create links</DialogTitle>
            <DialogDescription>
              One single-use link each, numbered, so a link can be matched to whoever was handed it.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>How many</Label>
              <Input
                type="number"
                min="1"
                max="200"
                value={batch.count}
                onChange={(e) => setBatch({ ...batch, count: e.target.value })}
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Project</Label>
              <Select
                value={batch.projectId}
                onValueChange={(v) => setBatch({ ...batch, projectId: v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Choose a project" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Role</Label>
              <Select value={batch.role} onValueChange={(v) => setBatch({ ...batch, role: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="reader">Reader</SelectItem>
                  <SelectItem value="writer">Writer</SelectItem>
                  <SelectItem value="maintainer">Maintainer</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Expires in (days)</Label>
              <Input
                type="number"
                min="1"
                max="365"
                value={batch.ttlDays}
                onChange={(e) => setBatch({ ...batch, ttlDays: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Label</Label>
              <Input
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

      <BatchResult links={minted} onClose={() => setMinted([])} />
    </div>
  );
};
