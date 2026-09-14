import { useState, useEffect, useCallback } from 'react';
import { Link2, Trash2 } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { DataTable } from './data-table';
import { InviteStatusBadge } from './InviteStatusBadge.jsx';
import { MintedLinkDialog } from './MintedLinkDialog.jsx';
import { useConfirm } from './ConfirmProvider';
import { notifySuccess, notifyError } from '../../lib/notify.js';
import { humanizeError } from '../../lib/errors.js';
import { useLatestCall } from '../../hooks/useLatestCall.js';
import { GRANT_ROLES, cap, fmtDate } from '../../domain/invites.js';

const EMPTY_FORM = { role: 'writer', maxUses: '1', ttlDays: '14', note: '' };

/**
 * A project's invitation links: the list, the minting dialog, and the revoke.
 *
 * `roleHints` says what each of the three levels grants, in the app's own
 * words, and is the same map the Access screen puts under its role picker.
 * Only Maintainer reads the same in both, which is why that one line lives in
 * `domain/permissions.js` rather than here.
 */
export const ProjectInvites = ({ projectId, projectName, client, canManage, roleHints = {} }) => {
  const confirm = useConfirm();
  const [invites, setInvites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [mintedCode, setMintedCode] = useState(null);

  const begin = useLatestCall();
  const load = useCallback(async () => {
    if (!canManage) return;
    // The project can change under this screen, and the list for the one just
    // left can answer last.
    const isCurrent = begin();
    try {
      setLoading(true);
      const rows = (await client.invites.list({ projectId })) || [];
      if (!isCurrent()) return;
      setInvites(rows);
    } catch (err) {
      if (!isCurrent()) return;
      console.error('Error loading invites:', err);
      notifyError(humanizeError(err), 'Could not load the invitation links');
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [client, projectId, canManage, begin]);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreate = async () => {
    // The two numbers are held as typed rather than clamped on every
    // keystroke: clamping means a field that cannot be cleared to retype.
    const maxUses = parseInt(form.maxUses, 10);
    const ttlDays = parseInt(form.ttlDays, 10);
    if (!Number.isInteger(maxUses) || maxUses < 1) {
      notifyError('Number of uses must be at least 1', 'Error');
      return;
    }
    if (!Number.isInteger(ttlDays) || ttlDays < 1) {
      notifyError('Expiry must be at least 1 day', 'Error');
      return;
    }
    try {
      setCreating(true);
      const inv = await client.invites.create({
        projectId,
        projectRole: form.role,
        maxUses,
        ttlDays,
        note: form.note.trim() || undefined,
      });
      setCreateOpen(false);
      setForm(EMPTY_FORM);
      setMintedCode(inv.code);
      await load();
    } catch (err) {
      console.error('Error creating invite:', err);
      notifyError(humanizeError(err), 'Could not create the link');
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (inv) => {
    const ok = await confirm({
      title: 'Revoke this invitation link',
      description:
        'The link stops working immediately. Anyone who already used it keeps their account and access.',
      confirmLabel: 'Revoke link',
      destructive: true,
    });
    if (!ok) return;
    try {
      await client.invites.revoke(inv.id);
      notifySuccess('Invitation link revoked', 'Success');
      await load();
    } catch (err) {
      console.error('Error revoking invite:', err);
      notifyError(humanizeError(err), 'Could not revoke the invitation link');
    }
  };

  if (!canManage) return null;

  const columns = [
    {
      key: 'note',
      label: 'Label',
      sort: (inv) => (inv.note || '').toLowerCase(),
      render: (inv) => inv.note || <em className="text-muted-foreground">Untitled</em>,
    },
    {
      key: 'grants',
      label: 'Grants',
      sort: (inv) => inv.projectRole || '',
      render: (inv) => cap(inv.projectRole),
    },
    {
      key: 'uses',
      label: 'Used',
      sort: (inv) => inv.uses,
      render: (inv) => `${inv.uses} / ${inv.maxUses}`,
    },
    {
      key: 'expires',
      label: 'Expires',
      sort: (inv) => (inv.expiresAt ? new Date(inv.expiresAt).getTime() : null),
      render: (inv) => fmtDate(inv.expiresAt),
    },
    {
      key: 'status',
      label: 'Status',
      sort: (inv) => inv.status,
      render: (inv) => <InviteStatusBadge status={inv.status} />,
    },
    {
      key: 'actions',
      label: '',
      headerClassName: 'w-12',
      align: 'right',
      render: (inv) =>
        inv.status === 'active' ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-destructive"
            aria-label="Revoke invitation link"
            onClick={() => handleRevoke(inv)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Invitation links</h2>
          <p className="text-sm text-muted-foreground">
            Send someone a link instead of a password. They choose their own credentials and join{' '}
            {projectName ? <strong>{projectName}</strong> : 'this project'} automatically. A link is
            not addressed to anyone: whoever opens it joins, including whoever it was forwarded to.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Link2 className="h-4 w-4" /> New link
        </Button>
      </div>

      <DataTable
        rows={invites}
        columns={columns}
        rowKey={(inv) => inv.id}
        id="project-invites"
        scope={projectId}
        defaultSort={{ key: 'expires', dir: 'desc' }}
        noun="link"
        loading={loading}
        empty="No invitation links yet."
      />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New invitation link</DialogTitle>
            <DialogDescription>
              Anyone with the link can create one account and join this project.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-role">They join as</Label>
              <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v })}>
                <SelectTrigger id="invite-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GRANT_ROLES.map((r) => (
                    <SelectItem key={r} value={r} hint={roleHints[r]}>
                      {cap(r)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-3">
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="invite-uses">Number of uses</Label>
                <Input
                  id="invite-uses"
                  type="number"
                  min="1"
                  value={form.maxUses}
                  onChange={(e) => setForm({ ...form, maxUses: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  Raise this to share one link with a whole class. Every use is a different person
                  choosing their own account.
                </p>
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="invite-ttl">Expires in (days)</Label>
                <Input
                  id="invite-ttl"
                  type="number"
                  min="1"
                  value={form.ttlDays}
                  onChange={(e) => setForm({ ...form, ttlDays: e.target.value })}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-note">Label (optional)</Label>
              <Input
                id="invite-note"
                placeholder="e.g. Fall 2026 field methods"
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                Only you see this. It is the only place to record who the link was meant for.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? 'Creating…' : 'Create link'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <MintedLinkDialog code={mintedCode} onClose={() => setMintedCode(null)} />
    </div>
  );
};
