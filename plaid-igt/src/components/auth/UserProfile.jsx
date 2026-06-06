import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { ArrowLeft, Copy, Check } from 'lucide-react';
import { notifySuccess, notifyError, notifyWarning } from '@/utils/feedback';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel,
} from '@/components/ui/alert-dialog';

const timeAgo = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
};

const EMPTY = (username = '') => ({ username, currentPassword: '', newPassword: '', confirmPassword: '' });

export const UserProfile = () => {
  const navigate = useNavigate();
  const { user, client, updateUser } = useAuth();
  const [isEditing, setIsEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fields, setFields] = useState(EMPTY(user?.username));
  const [errors, setErrors] = useState({});

  // --- Named API tokens ---
  const [tokens, setTokens] = useState([]);
  const [tokensLoading, setTokensLoading] = useState(true);
  const [newTokenName, setNewTokenName] = useState('');
  const [creatingToken, setCreatingToken] = useState(false);
  // Freshly-minted token, shown exactly once (the server never returns it again).
  const [mintedToken, setMintedToken] = useState(null);
  const [copied, setCopied] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState(null);

  const activeTokens = tokens.filter((t) => !t.revokedAt);

  const loadTokens = async () => {
    if (!user?.id || !client) return;
    try {
      setTokensLoading(true);
      const result = await client.apiTokens.list(user.id);
      setTokens(result || []);
    } catch (err) {
      console.error('Error loading API tokens:', err);
      notifyError('Failed to load API tokens', 'Error');
    } finally {
      setTokensLoading(false);
    }
  };

  useEffect(() => {
    loadTokens();
  }, [user?.id]);

  const handleCreateToken = async (e) => {
    e.preventDefault();
    const name = newTokenName.trim();
    if (!name) {
      notifyError('Please enter a name for the token', 'Error');
      return;
    }
    try {
      setCreatingToken(true);
      const result = await client.apiTokens.create(user.id, name); // { id, name, token }
      setMintedToken(result);
      setCopied(false);
      setNewTokenName('');
      await loadTokens();
    } catch (err) {
      console.error('Error creating API token:', err);
      notifyError('Failed to create API token: ' + (err.message || 'Unknown error'), 'Error');
    } finally {
      setCreatingToken(false);
    }
  };

  const handleCopyMinted = () => {
    if (!mintedToken?.token) return;
    navigator.clipboard.writeText(mintedToken.token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRevokeToken = async () => {
    if (!revokeTarget) return;
    try {
      await client.apiTokens.revoke(user.id, revokeTarget.id);
      if (mintedToken && mintedToken.id === revokeTarget.id) setMintedToken(null);
      notifySuccess('API token revoked', 'Success');
      setRevokeTarget(null);
      await loadTokens();
    } catch (err) {
      console.error('Error revoking API token:', err);
      notifyError('Failed to revoke API token: ' + (err.message || 'Unknown error'), 'Error');
    }
  };

  const set = (k) => (e) => setFields((f) => ({ ...f, [k]: e.target.value }));
  const fieldError = (k) => (errors[k] ? <p className="text-xs text-destructive">{errors[k]}</p> : null);

  const validate = () => {
    const er = {};
    if (!fields.username.trim()) er.username = 'Username is required';
    if (fields.newPassword && fields.newPassword.length < 6) er.newPassword = 'Password must be at least 6 characters long';
    if (fields.newPassword && fields.confirmPassword !== fields.newPassword) er.confirmPassword = 'Passwords do not match';
    if (fields.newPassword && !fields.currentPassword) er.currentPassword = 'Current password is required to change password';
    setErrors(er);
    return Object.keys(er).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) return;
    setLoading(true);
    try {
      if (!client) throw new Error('Not authenticated');
      if (!user.id) throw new Error('Could not get current user ID');

      const updateData = {};
      if (fields.username !== user.username) updateData.username = fields.username;
      if (fields.newPassword) updateData.password = fields.newPassword;

      if (Object.keys(updateData).length === 0) {
        notifyWarning('No changes to save', 'No Changes');
        setLoading(false);
        return;
      }

      // users.update(id, password, username, isAdmin)
      await client.users.update(user.id, updateData.password || undefined, updateData.username || undefined, undefined);
      const updatedUserData = await client.users.get(user.id);

      notifySuccess('Profile updated successfully!', 'Success');
      setIsEditing(false);
      setFields(EMPTY(updatedUserData.username));
      localStorage.setItem('username', updatedUserData.username);
      localStorage.setItem('isAdmin', (updatedUserData.isAdmin || false).toString());
      updateUser({ username: updatedUserData.username, isAdmin: updatedUserData.isAdmin || false });
    } catch (err) {
      notifyError(err.message || 'Failed to update profile', 'Error');
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    setIsEditing(false);
    setFields(EMPTY(user?.username));
    setErrors({});
  };

  return (
    <div className="tw mx-auto max-w-xl px-4 py-8">
      <Button variant="ghost" size="sm" className="mb-4" onClick={() => navigate(-1)}>
        <ArrowLeft className="h-4 w-4" /> Back
      </Button>

      <Card>
        <CardHeader>
          <CardTitle className="text-xl">User Profile</CardTitle>
        </CardHeader>
        <CardContent>
          {!isEditing ? (
            <div className="flex flex-col gap-4">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Username</p>
                <p className="text-lg">{user?.username}</p>
              </div>
              <Button className="self-start" onClick={() => setIsEditing(true)}>Edit Profile</Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="username">Username</Label>
                <Input id="username" value={fields.username} onChange={set('username')} placeholder="Enter username" />
                {fieldError('username')}
              </div>

              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <div className="h-px flex-1 bg-border" /> Change Password (Optional) <div className="h-px flex-1 bg-border" />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cur">Current Password</Label>
                <Input id="cur" type="password" value={fields.currentPassword} onChange={set('currentPassword')} placeholder="Enter current password" />
                {fieldError('currentPassword')}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="new">New Password</Label>
                <Input id="new" type="password" value={fields.newPassword} onChange={set('newPassword')} placeholder="Enter new password" />
                {fieldError('newPassword')}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="conf">Confirm New Password</Label>
                <Input id="conf" type="password" value={fields.confirmPassword} onChange={set('confirmPassword')} placeholder="Confirm new password" />
                {fieldError('confirmPassword')}
              </div>

              <div className="mt-2 flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={handleCancel} disabled={loading}>Cancel</Button>
                <Button type="submit" disabled={loading}>{loading ? 'Saving…' : 'Save Changes'}</Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      {/* API Tokens — named, revocable credentials for scripts & services.
          Attributed by name in the audit log, unlike the session token. */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-xl">API Tokens</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Create named tokens to access the API from external services (parsers, scripts, the Python{' '}
            <code>PlaidClient</code>). Each token carries your permissions, never expires, and survives
            password changes — revoke one to cut off access. Actions taken with a token are labelled by
            its name in the audit history.
          </p>

          {/* One-time reveal of a freshly minted token */}
          {mintedToken && (
            <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3">
              <p className="text-sm font-medium">Token &ldquo;{mintedToken.name}&rdquo; created</p>
              <p className="mb-2 mt-0.5 text-xs text-muted-foreground">Copy it now — you won&apos;t be able to see it again.</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded bg-background px-2 py-1 text-xs">{mintedToken.token}</code>
                <Button size="sm" variant="outline" onClick={handleCopyMinted}>
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {copied ? 'Copied!' : 'Copy'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setMintedToken(null)}>Done</Button>
              </div>
            </div>
          )}

          {/* Create form */}
          <form onSubmit={handleCreateToken} className="flex items-end gap-2">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="token-name">New token name</Label>
              <Input
                id="token-name"
                value={newTokenName}
                onChange={(e) => setNewTokenName(e.target.value)}
                placeholder="e.g. Stanza Parser"
              />
            </div>
            <Button type="submit" disabled={creatingToken}>{creatingToken ? 'Creating…' : 'Create Token'}</Button>
          </form>

          {/* Token list */}
          <div>
            {tokensLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted border-t-primary" />
                Loading tokens…
              </div>
            ) : activeTokens.length === 0 ? (
              <p className="text-sm text-muted-foreground">You have no active API tokens.</p>
            ) : (
              <div className="flex flex-col">
                {activeTokens.map((t) => (
                  <div key={t.id} className="flex items-center justify-between gap-2 border-t py-2 first:border-t-0">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{t.name}</p>
                      <p className="text-xs text-muted-foreground">Created {timeAgo(t.createdAt)}</p>
                    </div>
                    <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setRevokeTarget(t)}>
                      Revoke
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={!!revokeTarget} onOpenChange={(o) => { if (!o) setRevokeTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke API token?</AlertDialogTitle>
            <AlertDialogDescription>
              Revoke <strong>{revokeTarget?.name}</strong>? Any service using it will immediately lose access.
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleRevokeToken(); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
