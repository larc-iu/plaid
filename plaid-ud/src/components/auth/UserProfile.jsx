import { useState, useEffect, useRef } from 'react';
import { Check, Copy, ImagePlus } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { notifySuccess, notifyError } from '../../utils/feedback.jsx';
import { UserAvatar } from '@ui/components/shared/UserAvatar';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { Button } from '@ui/components/ui/button';
import { Input } from '@ui/components/ui/input';
import { Label } from '@ui/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@ui/components/ui/card';
import { timeAgo } from '../../utils/formatTime.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';

export const UserProfile = () => {
  useDocumentTitle('Profile');
  const { user, getClient, updateUser } = useAuth();
  const confirm = useConfirm();
  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState({
    displayName: user?.displayName || '',
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // --- Profile picture ---
  const fileInputRef = useRef(null);
  const [avatarBusy, setAvatarBusy] = useState(false);

  const handleAvatarPick = async (e) => {
    const file = e.target.files?.[0];
    // Clear the input so picking the same file twice still fires a change.
    e.target.value = '';
    if (!file) return;
    setAvatarBusy(true);
    try {
      // The server crops, resizes, and re-encodes, so the raw file goes up as
      // the user chose it.
      const updated = await getClient().users.setAvatar(user.id, file);
      updateUser({ avatarHash: updated.avatarHash });
      notifySuccess('Profile picture updated');
    } catch (err) {
      console.error('Error uploading profile picture:', err);
      notifyError(err.message || 'Failed to upload profile picture');
    } finally {
      setAvatarBusy(false);
    }
  };

  const handleAvatarRemove = async () => {
    setAvatarBusy(true);
    try {
      await getClient().users.deleteAvatar(user.id);
      updateUser({ avatarHash: null });
      notifySuccess('Profile picture removed');
    } catch (err) {
      console.error('Error removing profile picture:', err);
      notifyError(err.message || 'Failed to remove profile picture');
    } finally {
      setAvatarBusy(false);
    }
  };

  // --- API token management state ---
  const [tokens, setTokens] = useState([]);
  const [tokensLoading, setTokensLoading] = useState(true);
  const [tokensError, setTokensError] = useState('');
  const [newTokenName, setNewTokenName] = useState('');
  const [creatingToken, setCreatingToken] = useState(false);
  // The freshly-minted token, shown exactly once (the server never returns
  // the signed string again). Cleared when the user dismisses it.
  const [mintedToken, setMintedToken] = useState(null);
  const [copied, setCopied] = useState(false);

  const handleCopyMinted = () => {
    navigator.clipboard?.writeText(mintedToken.token).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const loadTokens = async () => {
    if (!user?.id) return;
    try {
      setTokensLoading(true);
      const client = getClient();
      const result = await client.apiTokens.list(user.id);
      setTokens(result || []);
      setTokensError('');
    } catch (err) {
      console.error('Error loading API tokens:', err);
      setTokensError('Failed to load API tokens');
    } finally {
      setTokensLoading(false);
    }
  };

  // The token list is fetched once per user. `loadTokens` is redefined every
  // render, so naming it here would refetch on every render.
  useEffect(() => {
    loadTokens();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const handleCreateToken = async (e) => {
    e.preventDefault();
    const name = newTokenName.trim();
    if (!name) {
      setTokensError('Name the token.');
      return;
    }
    try {
      setCreatingToken(true);
      setTokensError('');
      const client = getClient();
      const result = await client.apiTokens.create(user.id, name);
      setMintedToken(result); // { id, name, token } — shown once
      setNewTokenName('');
      await loadTokens();
    } catch (err) {
      console.error('Error creating API token:', err);
      setTokensError('Failed to create API token: ' + (err.message || 'Unknown error'));
    } finally {
      setCreatingToken(false);
    }
  };

  const handleRevokeToken = async (tokenId) => {
    const ok = await confirm({
      title: 'Revoke API token',
      description: 'Any service using it loses access immediately. This cannot be undone.',
      confirmLabel: 'Revoke',
      destructive: true,
    });
    if (!ok) return;
    try {
      setTokensError('');
      const client = getClient();
      await client.apiTokens.revoke(user.id, tokenId);
      // If we just revoked the token we're still showing, hide it.
      if (mintedToken && mintedToken.id === tokenId) setMintedToken(null);
      notifySuccess('API token revoked');
      await loadTokens();
    } catch (err) {
      console.error('Error revoking API token:', err);
      setTokensError('Failed to revoke API token: ' + (err.message || 'Unknown error'));
    }
  };

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    // Clear messages when user starts typing
    if (error) setError('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const client = getClient();

      if (!formData.displayName.trim()) {
        setError('Enter a display name');
        setLoading(false);
        return;
      }

      // Validate passwords if changing password
      if (formData.newPassword) {
        if (formData.newPassword !== formData.confirmPassword) {
          setError('New passwords do not match');
          setLoading(false);
          return;
        }
        if (formData.newPassword.length < 6) {
          setError('Password must be at least 6 characters long');
          setLoading(false);
          return;
        }
        if (!formData.currentPassword) {
          setError('Current password is required to change password');
          setLoading(false);
          return;
        }
      }

      // Use the user ID from the user object
      if (!user.id) {
        setError('Could not get current user ID');
        setLoading(false);
        return;
      }

      const updateData = {};

      // Only include the display name if it changed
      if (formData.displayName !== user.displayName) {
        updateData.displayName = formData.displayName;
      }

      // Only include password if it's being changed
      if (formData.newPassword) {
        updateData.password = formData.newPassword;
      }

      // If no changes, don't make API call
      if (Object.keys(updateData).length === 0) {
        setError('No changes to save');
        setLoading(false);
        return;
      }

      // Call users.update with correct parameter order: (id, password, displayName, isAdmin)
      await client.users.update(
        user.id,
        updateData.password || undefined,
        updateData.displayName || undefined,
        undefined, // isAdmin - we don't change this here
      );

      // Fetch updated user data from server to get complete profile including isAdmin
      const updatedUserData = await client.users.get(user.id);

      notifySuccess('Profile updated');
      setIsEditing(false);

      // Clear password fields
      setFormData((prev) => ({
        ...prev,
        currentPassword: '',
        newPassword: '',
        confirmPassword: '',
      }));

      // Update localStorage and auth context with complete user data
      localStorage.setItem('displayName', updatedUserData.displayName);
      // Note: PlaidClient transforms is-admin to isAdmin
      localStorage.setItem('isAdmin', (updatedUserData.isAdmin || false).toString());

      // Update the auth context with complete user data
      updateUser({
        displayName: updatedUserData.displayName,
        isAdmin: updatedUserData.isAdmin || false,
      });

      // Update form data to reflect the new display name
      setFormData((prev) => ({ ...prev, displayName: updatedUserData.displayName }));
    } catch (err) {
      setError(err.message || 'Failed to update profile');
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    setIsEditing(false);
    setFormData({
      displayName: user?.displayName || '',
      currentPassword: '',
      newPassword: '',
      confirmPassword: '',
    });
    setError('');
  };

  // Revoked tokens are kept server-side forever (so the audit log can always
  // resolve a token's name), but there's no reason to surface dead credentials
  // in the management UI — show only the active ones.
  const activeTokens = tokens.filter((t) => !t.revokedAt);

  return (
    <div className="tw mx-auto flex max-w-2xl flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">User Profile</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-6 flex items-center gap-4">
            <UserAvatar
              client={getClient()}
              userId={user?.id}
              displayName={user?.displayName}
              avatarHash={user?.avatarHash}
              className="h-20 w-20"
              fallbackClassName="text-2xl"
            />
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className="hidden"
                  onChange={handleAvatarPick}
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={avatarBusy}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <ImagePlus className="h-4 w-4" />
                  {user?.avatarHash ? 'Change picture' : 'Upload picture'}
                </Button>
                {user?.avatarHash && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={avatarBusy}
                    onClick={handleAvatarRemove}
                  >
                    Remove
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                PNG, JPEG, WebP or GIF. Cropped to a square and resized for you.
              </p>
            </div>
          </div>

          {!isEditing ? (
            <div className="flex flex-col gap-4">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Display name</p>
                <p className="text-lg">{user?.displayName}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Email address</p>
                <p className="text-lg">{user?.id}</p>
              </div>
              <Button className="self-start" onClick={() => setIsEditing(true)}>
                Edit profile
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              {error && (
                <div
                  role="alert"
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  {error}
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="displayName">Display name</Label>
                <Input
                  id="displayName"
                  name="displayName"
                  value={formData.displayName}
                  onChange={handleInputChange}
                  placeholder="How you appear to your collaborators"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="email">Email address</Label>
                <Input id="email" value={user?.id ?? ''} disabled readOnly />
                <p className="text-xs text-muted-foreground">
                  What you sign in with. Ask an administrator to change it.
                </p>
              </div>

              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <div className="h-px flex-1 bg-border" /> Change password (optional){' '}
                <div className="h-px flex-1 bg-border" />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="currentPassword">Current password</Label>
                <Input
                  id="currentPassword"
                  type="password"
                  name="currentPassword"
                  value={formData.currentPassword}
                  onChange={handleInputChange}
                  autoComplete="current-password"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="newPassword">New password</Label>
                <Input
                  id="newPassword"
                  type="password"
                  name="newPassword"
                  value={formData.newPassword}
                  onChange={handleInputChange}
                  autoComplete="new-password"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="confirmPassword">Confirm new password</Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  name="confirmPassword"
                  value={formData.confirmPassword}
                  onChange={handleInputChange}
                  autoComplete="new-password"
                />
              </div>

              <div className="mt-2 flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={handleCancel} disabled={loading}>
                  Cancel
                </Button>
                <Button type="submit" disabled={loading}>
                  {loading ? 'Saving…' : 'Save changes'}
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      {/* API Tokens — named, revocable credentials for scripts and services.
          Actions performed with one are attributed by name in the audit log,
          unlike the session token. They carry the same permissions as you. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">API Tokens</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Create named tokens to access the API from external services (parsers, scripts, the
            Python <code>PlaidClient</code>). Each token carries your permissions, never expires,
            and survives password changes. Revoke one to cut off access. Actions taken with a token
            are labelled by its name in the audit history.
          </p>

          {tokensError && (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {tokensError}
            </div>
          )}

          {/* One-time reveal of a freshly minted token */}
          {mintedToken && (
            <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3">
              <p className="text-sm font-medium">Token &ldquo;{mintedToken.name}&rdquo; created</p>
              <p className="mb-2 mt-0.5 text-xs text-muted-foreground">
                Copy it now. You will not be able to see it again.
              </p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded bg-background px-2 py-1 text-xs">
                  {mintedToken.token}
                </code>
                <Button size="sm" variant="outline" onClick={handleCopyMinted}>
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {copied ? 'Copied' : 'Copy'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setMintedToken(null)}>
                  Done
                </Button>
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
            <Button type="submit" disabled={creatingToken}>
              {creatingToken ? 'Creating…' : 'Create token'}
            </Button>
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
                  <div
                    key={t.id}
                    className="flex items-center justify-between gap-2 border-t py-2 first:border-t-0"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{t.name}</p>
                      <p className="text-xs text-muted-foreground">
                        Created {timeAgo(t.createdAt) || 'unknown'}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => handleRevokeToken(t.id)}
                    >
                      Revoke
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
