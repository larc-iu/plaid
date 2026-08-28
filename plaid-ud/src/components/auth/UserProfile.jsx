import { useState, useEffect, useRef } from 'react';
import {
  Stack,
  Paper,
  Title,
  Text,
  Button,
  Group,
  Alert,
  TextInput,
  PasswordInput,
  Divider,
  Code,
  CopyButton,
  Loader,
  Box,
} from '@mantine/core';
import { useAuth } from '../../contexts/AuthContext';
import { isEmail, EMAIL_INVALID_MESSAGE } from '../../utils/email';
import { UserAvatar } from '../common/UserAvatar';
import { confirmDelete, notifySuccess, notifyError } from '../../utils/feedback.jsx';
import { timeAgo } from '../../utils/formatTime.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';

export const UserProfile = () => {
  useDocumentTitle('Profile');
  const { user, getClient, updateUser } = useAuth();
  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState({
    username: user?.username || '',
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

  useEffect(() => {
    loadTokens();
  }, [user?.id]);

  const handleCreateToken = async (e) => {
    e.preventDefault();
    const name = newTokenName.trim();
    if (!name) {
      setTokensError('Please enter a name for the token');
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

  const handleRevokeToken = (tokenId) => {
    confirmDelete({
      title: 'Revoke API token',
      message:
        'Revoke this API token? Any service using it will immediately lose access. This cannot be undone.',
      confirmLabel: 'Revoke',
      onConfirm: async () => {
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
      },
    });
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

      if (!isEmail(formData.username)) {
        setError(EMAIL_INVALID_MESSAGE);
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

      // Only include username if it changed
      if (formData.username !== user.username) {
        updateData.username = formData.username;
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

      // Call users.update with correct parameter order: (id, password, username, isAdmin)
      await client.users.update(
        user.id,
        updateData.password || undefined,
        updateData.username || undefined,
        undefined, // isAdmin - we don't change this here
      );

      // Fetch updated user data from server to get complete profile including isAdmin
      const updatedUserData = await client.users.get(user.id);

      notifySuccess('Profile updated successfully!');
      setIsEditing(false);

      // Clear password fields
      setFormData((prev) => ({
        ...prev,
        currentPassword: '',
        newPassword: '',
        confirmPassword: '',
      }));

      // Update localStorage and auth context with complete user data
      localStorage.setItem('username', updatedUserData.username);
      // Note: PlaidClient transforms is-admin to isAdmin
      localStorage.setItem('isAdmin', (updatedUserData.isAdmin || false).toString());

      // Update the auth context with complete user data
      updateUser({
        username: updatedUserData.username,
        isAdmin: updatedUserData.isAdmin || false,
      });

      // Update form data to reflect the new username
      setFormData((prev) => ({ ...prev, username: updatedUserData.username }));
    } catch (err) {
      setError(err.message || 'Failed to update profile');
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    setIsEditing(false);
    setFormData({
      username: user?.username || '',
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
    <Stack maw={672} mx="auto" gap="lg">
      <Paper withBorder radius="md" p="lg">
        <Title order={3} mb="lg">
          User Profile
        </Title>

        <Group gap="md" mb="lg" align="center">
          <UserAvatar
            client={getClient()}
            userId={user?.id}
            username={user?.username}
            avatarHash={user?.avatarHash}
            size={80}
          />
          <Stack gap={6}>
            <Group gap="xs">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                style={{ display: 'none' }}
                onChange={handleAvatarPick}
              />
              <Button
                size="xs"
                variant="default"
                loading={avatarBusy}
                onClick={() => fileInputRef.current?.click()}
              >
                {user?.avatarHash ? 'Change picture' : 'Upload picture'}
              </Button>
              {user?.avatarHash && (
                <Button
                  size="xs"
                  variant="subtle"
                  color="gray"
                  disabled={avatarBusy}
                  onClick={handleAvatarRemove}
                >
                  Remove
                </Button>
              )}
            </Group>
            <Text size="xs" c="dimmed">
              PNG, JPEG, WebP, or GIF. Cropped to a square and resized for you.
            </Text>
          </Stack>
        </Group>

        {!isEditing ? (
          <Stack gap="md" align="flex-start">
            <div>
              <Text size="sm" fw={500} c="dimmed">
                Email address
              </Text>
              <Text>{user?.username}</Text>
            </div>
            <Button onClick={() => setIsEditing(true)}>Edit Profile</Button>
          </Stack>
        ) : (
          <form onSubmit={handleSubmit}>
            <Stack gap="md">
              {error && <Alert color="red">{error}</Alert>}

              <TextInput
                label="Email address"
                type="email"
                name="username"
                value={formData.username}
                onChange={handleInputChange}
                required
              />

              <Divider label="Change Password (Optional)" labelPosition="left" />

              <PasswordInput
                label="Current Password"
                name="currentPassword"
                value={formData.currentPassword}
                onChange={handleInputChange}
              />
              <PasswordInput
                label="New Password"
                name="newPassword"
                value={formData.newPassword}
                onChange={handleInputChange}
              />
              <PasswordInput
                label="Confirm New Password"
                name="confirmPassword"
                value={formData.confirmPassword}
                onChange={handleInputChange}
              />

              <Group justify="flex-end" gap="sm">
                <Button type="button" variant="default" onClick={handleCancel}>
                  Cancel
                </Button>
                <Button type="submit" loading={loading}>
                  Save Changes
                </Button>
              </Group>
            </Stack>
          </form>
        )}
      </Paper>

      {/* API Tokens — named, revocable credentials for scripts & services.
          Actions performed with one are attributed by name in the audit log,
          unlike the session token. They carry the same permissions as you. */}
      <Paper withBorder radius="md" p="lg">
        <Title order={3}>API Tokens</Title>
        <Text size="sm" c="dimmed" mt={4}>
          Create named tokens to access the API from external services (parsers, scripts, the Python{' '}
          <Code>PlaidClient</Code>). Each token carries your permissions, never expires, and
          survives password changes — revoke one to cut off access. Actions taken with a token are
          labelled by its name in the audit history.
        </Text>

        {tokensError && (
          <Alert color="red" mt="md">
            {tokensError}
          </Alert>
        )}

        {/* One-time reveal of a freshly minted token */}
        {mintedToken && (
          <Alert color="yellow" mt="md" title={`Token "${mintedToken.name}" created`}>
            <Text size="sm" mb="xs">
              Copy it now — you won’t be able to see it again.
            </Text>
            <Group gap="xs" wrap="nowrap" align="center">
              <Code style={{ flex: 1, wordBreak: 'break-all' }}>{mintedToken.token}</Code>
              <CopyButton value={mintedToken.token} timeout={2000}>
                {({ copied, copy }) => (
                  <Button size="xs" color={copied ? 'teal' : 'yellow'} onClick={copy}>
                    {copied ? '✓ Copied!' : 'Copy'}
                  </Button>
                )}
              </CopyButton>
              <Button size="xs" variant="default" onClick={() => setMintedToken(null)}>
                Done
              </Button>
            </Group>
          </Alert>
        )}

        {/* Create form */}
        <form onSubmit={handleCreateToken}>
          <Group align="flex-end" gap="sm" mt="md">
            <TextInput
              style={{ flex: 1 }}
              label="New token name"
              value={newTokenName}
              onChange={(e) => setNewTokenName(e.target.value)}
              placeholder="e.g. Stanza Parser"
            />
            <Button type="submit" loading={creatingToken}>
              Create Token
            </Button>
          </Group>
        </form>

        {/* Token list */}
        <Box mt="lg">
          {tokensLoading ? (
            <Group gap="xs">
              <Loader size="sm" />
              <Text size="sm" c="dimmed">
                Loading tokens…
              </Text>
            </Group>
          ) : activeTokens.length === 0 ? (
            <Text size="sm" c="dimmed">
              You have no active API tokens.
            </Text>
          ) : (
            <Stack gap={0}>
              {activeTokens.map((t, i) => (
                <Group
                  key={t.id}
                  justify="space-between"
                  wrap="nowrap"
                  py="sm"
                  style={{ borderTop: '1px solid var(--mantine-color-gray-2)' }}
                >
                  <div style={{ minWidth: 0 }}>
                    <Text size="sm" fw={500} truncate>
                      {t.name}
                    </Text>
                    <Text size="xs" c="dimmed">
                      Created {timeAgo(t.createdAt) || 'unknown'}
                    </Text>
                  </div>
                  <Button
                    variant="subtle"
                    color="red"
                    size="compact-sm"
                    onClick={() => handleRevokeToken(t.id)}
                  >
                    Revoke
                  </Button>
                </Group>
              ))}
            </Stack>
          )}
        </Box>
      </Paper>
    </Stack>
  );
};
