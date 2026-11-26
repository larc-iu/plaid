import { useState, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, Copy, Check, ImagePlus } from 'lucide-react';
import { useAuth } from '../../contexts/useAuth.js';
import { timeAgo, fullTimestamp } from '../../lib/formatTime.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { notifySuccess, notifyError, notifyWarning } from '../../lib/notify.js';
import { humanizeError, refusalSaid } from '../../lib/errors.js';
import { cn } from '../../lib/utils.js';
import { appRoutes } from '../../lib/uiConfig.js';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Card, CardHeader, CardTitle, CardContent } from '../ui/card';
import { UserAvatar } from '../shared/UserAvatar';
import { Loading } from '../shared/Loading.jsx';
import { Notice } from '../shared/Notice.jsx';
import { useConfirm } from '../shared/ConfirmProvider';
import { usePasswordMinimum, passwordTooShort } from '../../hooks/usePasswordMinimum.js';
import { t, tx } from '../../lib/i18n.js';

const EMPTY = (displayName = '') => ({
  displayName,
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
});

/**
 * The account screen: display name, password, profile picture, API tokens.
 *
 * `className` is the outer wrapper's, because the two shells differ: plaid-ud's
 * Outlet is already padded and plaid-igt's is not. `children` are further cards
 * of the app's own (its keyboard shortcuts), drawn after the shared ones.
 */
export const UserProfile = ({ className, children }) => {
  useDocumentTitle(t('Profile'));
  const navigate = useNavigate();
  const location = useLocation();
  const confirm = useConfirm();
  const { user, client, updateUser, logout } = useAuth();
  const passwordMinimum = usePasswordMinimum();
  const [isEditing, setIsEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fields, setFields] = useState(EMPTY(user?.displayName));
  const [errors, setErrors] = useState({});

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
      const updated = await client.users.setAvatar(user.id, file);
      updateUser({ avatarHash: updated.avatarHash });
      notifySuccess(t('Profile picture updated'));
    } catch (err) {
      console.error('Error uploading profile picture:', err);
      notifyError(humanizeError(err), t('Failed to upload the picture'));
    } finally {
      setAvatarBusy(false);
    }
  };

  const handleAvatarRemove = async () => {
    setAvatarBusy(true);
    try {
      await client.users.deleteAvatar(user.id);
      updateUser({ avatarHash: null });
      notifySuccess(t('Profile picture removed'));
    } catch (err) {
      console.error('Error removing profile picture:', err);
      notifyError(humanizeError(err), t('Failed to remove the picture'));
    } finally {
      setAvatarBusy(false);
    }
  };

  // --- Named API tokens ---
  const [tokens, setTokens] = useState([]);
  const [tokensLoading, setTokensLoading] = useState(true);
  const [newTokenName, setNewTokenName] = useState('');
  const [creatingToken, setCreatingToken] = useState(false);
  // Freshly-minted token, shown exactly once (the server never returns it again).
  const [mintedToken, setMintedToken] = useState(null);
  const [copied, setCopied] = useState(false);

  // A revoked token's row stays on the server forever, so the audit log can
  // always resolve its name. Only the live ones belong on this screen.
  const activeTokens = tokens.filter((tk) => !tk.revokedAt);

  const loadTokens = async () => {
    if (!user?.id || !client) return;
    try {
      setTokensLoading(true);
      const result = await client.apiTokens.list(user.id);
      setTokens(result || []);
    } catch (err) {
      console.error('Error loading API tokens:', err);
      notifyError(humanizeError(err), t('Failed to load the tokens'));
    } finally {
      setTokensLoading(false);
    }
  };

  useEffect(() => {
    loadTokens();
    // Runs once per id; the loader reads the client fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const handleCreateToken = async (e) => {
    e.preventDefault();
    const name = newTokenName.trim();
    if (!name) {
      notifyError(t('Name the token'), t('Failed to create the token'));
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
      notifyError(humanizeError(err), t('Failed to create the token'));
    } finally {
      setCreatingToken(false);
    }
  };

  const handleCopyMinted = () => {
    if (!mintedToken?.token) return;
    navigator.clipboard?.writeText(mintedToken.token).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRevokeToken = async (token) => {
    const ok = await confirm({
      title: t('Revoke “{name}”?', { name: token.name }),
      description: t(
        'Any service using this token loses access immediately. This cannot be undone.',
      ),
      confirmLabel: t('Revoke'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await client.apiTokens.revoke(user.id, token.id);
      if (mintedToken && mintedToken.id === token.id) setMintedToken(null);
      notifySuccess(t('API token revoked'));
      await loadTokens();
    } catch (err) {
      console.error('Error revoking API token:', err);
      notifyError(humanizeError(err), t('Failed to revoke the token'));
    }
  };

  const set = (k) => (e) => setFields((f) => ({ ...f, [k]: e.target.value }));
  const fieldError = (k) =>
    errors[k] ? <p className="text-xs text-destructive">{errors[k]}</p> : null;

  const validate = () => {
    const er = {};
    if (!fields.displayName.trim()) er.displayName = t('Enter a display name');
    const tooShort = fields.newPassword && passwordTooShort(fields.newPassword, passwordMinimum);
    if (tooShort) er.newPassword = tooShort;
    if (fields.newPassword && fields.confirmPassword !== fields.newPassword)
      er.confirmPassword = t('Passwords do not match');
    if (fields.newPassword && !fields.currentPassword)
      er.currentPassword = t('Current password is required to change password');
    setErrors(er);
    return Object.keys(er).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) return;
    setLoading(true);
    try {
      if (!client) throw new Error('Not authenticated');
      if (!user.id) throw new Error('Not signed in.');

      const updateData = {};
      if (fields.displayName !== user.displayName) updateData.displayName = fields.displayName;
      if (fields.newPassword) updateData.password = fields.newPassword;

      if (Object.keys(updateData).length === 0) {
        notifyWarning(t('No changes to save'));
        setLoading(false);
        return;
      }

      await client.users.update(
        user.id,
        updateData.password || undefined,
        updateData.displayName || undefined,
        undefined,
        undefined,
        updateData.password ? { currentPassword: fields.currentPassword } : {},
      );
      // A new password ends every session of the account, this one too.
      if (updateData.password) {
        logout('password-changed');
        return;
      }
      const updatedUserData = await client.users.get(user.id);

      notifySuccess(t('Profile updated'));
      setIsEditing(false);
      setFields(EMPTY(updatedUserData.displayName));
      localStorage.setItem('displayName', updatedUserData.displayName);
      localStorage.setItem('isAdmin', (updatedUserData.isAdmin || false).toString());
      updateUser({
        displayName: updatedUserData.displayName,
        isAdmin: updatedUserData.isAdmin || false,
      });
    } catch (err) {
      // A refused current password belongs on its field.
      const refused = fields.newPassword && refusalSaid(err);
      if (refused) setErrors({ currentPassword: refused });
      else notifyError(humanizeError(err), t('Failed to save the profile'));
    } finally {
      setLoading(false);
    }
  };

  // The page before this one, or the app's home when the profile is the
  // tab's first page in the app: Back never leaves the app. A bookmark or a
  // pasted link has the default key, and one reached through sign-in was
  // put in its place (LoginForm's replace), so it has a key of its own and
  // the router's index 0.
  const goBack = () => {
    const first = location.key === 'default' || window.history.state?.idx === 0;
    if (first) navigate(appRoutes().projects);
    else navigate(-1);
  };

  const handleCancel = () => {
    setIsEditing(false);
    setFields(EMPTY(user?.displayName));
    setErrors({});
  };

  return (
    <div className={cn('mx-auto flex max-w-2xl flex-col gap-6', className)}>
      <div>
        <Button variant="ghost" size="sm" onClick={goBack}>
          <ArrowLeft className="h-4 w-4" /> {t('Back')}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('User profile')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-6 flex items-center gap-4">
            <UserAvatar
              client={client}
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
                  {user?.avatarHash ? t('Change picture') : t('Upload picture')}
                </Button>
                {user?.avatarHash && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={avatarBusy}
                    onClick={handleAvatarRemove}
                  >
                    {t('Remove')}
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {t('PNG, JPEG, WebP or GIF. Cropped to a square and resized.')}
              </p>
            </div>
          </div>

          {!isEditing ? (
            <div className="flex flex-col gap-4">
              <div>
                <p className="text-sm font-medium text-muted-foreground">{t('Display name')}</p>
                <p className="text-lg">{user?.displayName}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">{t('Email address')}</p>
                <p className="text-lg">{user?.id}</p>
              </div>
              <Button className="self-start" onClick={() => setIsEditing(true)}>
                {t('Edit profile')}
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="displayName">{t('Display name')}</Label>
                <Input
                  id="displayName"
                  value={fields.displayName}
                  onChange={set('displayName')}
                  placeholder={t('How you appear to your collaborators')}
                />
                {fieldError('displayName')}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="email">{t('Email address')}</Label>
                <Input id="email" value={user?.id ?? ''} disabled readOnly />
                <p className="text-xs text-muted-foreground">
                  {t('What you sign in with. Ask an administrator to change it.')}
                </p>
              </div>

              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <div className="h-px flex-1 bg-border" /> {t('Change password (optional)')}{' '}
                <div className="h-px flex-1 bg-border" />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="currentPassword">{t('Current password')}</Label>
                <Input
                  id="currentPassword"
                  type="password"
                  value={fields.currentPassword}
                  onChange={set('currentPassword')}
                  autoComplete="current-password"
                />
                {fieldError('currentPassword')}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="newPassword">{t('New password')}</Label>
                <Input
                  id="newPassword"
                  type="password"
                  value={fields.newPassword}
                  onChange={set('newPassword')}
                  autoComplete="new-password"
                />
                {fieldError('newPassword')}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="confirmPassword">{t('Confirm new password')}</Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  value={fields.confirmPassword}
                  onChange={set('confirmPassword')}
                  autoComplete="new-password"
                />
                {fieldError('confirmPassword')}
              </div>

              <div className="mt-2 flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={handleCancel} disabled={loading}>
                  {t('Cancel')}
                </Button>
                <Button type="submit" disabled={loading}>
                  {loading ? t('Saving…') : t('Save changes')}
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      {/* API Tokens: named, revocable credentials for scripts and services.
          Actions taken with one are attributed by name in the audit log,
          unlike the session token. They carry the same permissions as you. */}
      <Card>
        <CardHeader>
          <CardTitle>{t('API tokens')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            {tx(
              'A named credential for scripts and services (parsers, the Python <code>PlaidClient</code>). It carries your permissions and does not expire. Actions taken with one are labelled by its name in the audit history.',
              { code: (c) => <code>{c}</code> },
            )}
          </p>

          {/* One-time reveal of a freshly minted token */}
          {mintedToken && (
            <Notice tone="warning" className="p-3">
              <p className="text-sm font-medium">
                {t('Token “{name}” created', { name: mintedToken.name })}
              </p>
              <p className="mb-2 mt-0.5 text-xs">{t('Copy it now. It is not shown again.')}</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded bg-background px-2 py-1 text-xs">
                  {mintedToken.token}
                </code>
                <Button size="sm" variant="outline" onClick={handleCopyMinted}>
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {copied ? t('Copied') : t('Copy')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setMintedToken(null)}>
                  {t('Done')}
                </Button>
              </div>
            </Notice>
          )}

          {/* Create form */}
          <form onSubmit={handleCreateToken} className="flex items-end gap-2">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="token-name">{t('New token name')}</Label>
              <Input
                id="token-name"
                value={newTokenName}
                onChange={(e) => setNewTokenName(e.target.value)}
                // service-ok: an example of a name a person types
                placeholder={t('e.g. Stanza parser')}
              />
            </div>
            <Button type="submit" disabled={creatingToken}>
              {creatingToken ? t('Creating…') : t('Create token')}
            </Button>
          </form>

          {/* Token list */}
          <div>
            {tokensLoading ? (
              <Loading label={t('Loading tokens…')} className="p-0" />
            ) : activeTokens.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('No active tokens.')}</p>
            ) : (
              <div className="flex flex-col">
                {activeTokens.map((tk) => (
                  <div
                    key={tk.id}
                    className="flex items-center justify-between gap-2 border-t py-2 first:border-t-0"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{tk.name}</p>
                      <p
                        className="text-xs text-muted-foreground"
                        title={fullTimestamp(tk.createdAt)}
                      >
                        {timeAgo(tk.createdAt)
                          ? t('Created {when}', { when: timeAgo(tk.createdAt) })
                          : t('Created unknown')}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => handleRevokeToken(tk)}
                    >
                      {t('Revoke')}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
      {children}
    </div>
  );
};
