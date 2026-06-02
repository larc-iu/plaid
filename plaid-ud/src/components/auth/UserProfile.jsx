import { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';

export const UserProfile = () => {
  const { user, getClient, updateUser } = useAuth();
  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState({
    username: user?.username || '',
    currentPassword: '',
    newPassword: '',
    confirmPassword: ''
  });
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  // --- API token management state ---
  const [tokens, setTokens] = useState([]);
  const [tokensLoading, setTokensLoading] = useState(true);
  const [tokensError, setTokensError] = useState('');
  const [newTokenName, setNewTokenName] = useState('');
  const [creatingToken, setCreatingToken] = useState(false);
  // The freshly-minted token, shown exactly once (the server never returns
  // the signed string again). Cleared when the user dismisses it.
  const [mintedToken, setMintedToken] = useState(null);
  const [mintedCopied, setMintedCopied] = useState(false);

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
      setMintedCopied(false);
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
    if (!confirm('Revoke this API token? Any service using it will immediately lose access. This cannot be undone.')) {
      return;
    }
    try {
      setTokensError('');
      const client = getClient();
      await client.apiTokens.revoke(user.id, tokenId);
      // If we just revoked the token we're still showing, hide it.
      if (mintedToken && mintedToken.id === tokenId) setMintedToken(null);
      await loadTokens();
    } catch (err) {
      console.error('Error revoking API token:', err);
      setTokensError('Failed to revoke API token: ' + (err.message || 'Unknown error'));
    }
  };

  const handleCopyMinted = async () => {
    try {
      await navigator.clipboard.writeText(mintedToken.token);
      setMintedCopied(true);
      setTimeout(() => setMintedCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy token:', err);
      setTokensError('Failed to copy token to clipboard');
    }
  };

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
    // Clear messages when user starts typing
    if (error) setError('');
    if (success) setSuccess('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setSuccess('');

    try {
      const client = getClient();
      
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
        undefined // isAdmin - we don't change this here
      );
      
      // Fetch updated user data from server to get complete profile including isAdmin
      const updatedUserData = await client.users.get(user.id);

      setSuccess('Profile updated successfully!');
      setIsEditing(false);
      
      // Clear password fields
      setFormData(prev => ({
        ...prev,
        currentPassword: '',
        newPassword: '',
        confirmPassword: ''
      }));

      // Update localStorage and auth context with complete user data
      localStorage.setItem('username', updatedUserData.username);
      // Note: PlaidClient transforms is-admin to isAdmin
      localStorage.setItem('isAdmin', (updatedUserData.isAdmin || false).toString());
      
      // Update the auth context with complete user data
      updateUser({ 
        username: updatedUserData.username,
        isAdmin: updatedUserData.isAdmin || false
      });
      
      // Update form data to reflect the new username
      setFormData(prev => ({
        ...prev,
        username: updatedUserData.username
      }));
      
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
      confirmPassword: ''
    });
    setError('');
    setSuccess('');
  };

  // Revoked tokens are kept server-side forever (so the audit log can always
  // resolve a token's name), but there's no reason to surface dead credentials
  // in the management UI — show only the active ones.
  const activeTokens = tokens.filter((t) => !t.revokedAt);

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <h2 className="text-lg font-medium text-gray-900 mb-6">User Profile</h2>
          
          {!isEditing ? (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">Username</label>
                <p className="mt-1 text-sm text-gray-900">{user?.username}</p>
              </div>
              
              <div className="pt-4">
                <button
                  onClick={() => setIsEditing(true)}
                  className="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                >
                  Edit Profile
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-6">
              {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
                  {error}
                </div>
              )}
              
              {success && (
                <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded">
                  {success}
                </div>
              )}

              <div>
                <label htmlFor="username" className="block text-sm font-medium text-gray-700">
                  Username
                </label>
                <input
                  type="text"
                  id="username"
                  name="username"
                  value={formData.username}
                  onChange={handleInputChange}
                  className="mt-1 block w-full border border-gray-300 rounded-md px-3 py-2 shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                  required
                />
              </div>

              <div className="border-t border-gray-200 pt-6">
                <h3 className="text-md font-medium text-gray-900 mb-4">Change Password (Optional)</h3>
                
                <div className="space-y-4">
                  <div>
                    <label htmlFor="currentPassword" className="block text-sm font-medium text-gray-700">
                      Current Password
                    </label>
                    <input
                      type="password"
                      id="currentPassword"
                      name="currentPassword"
                      value={formData.currentPassword}
                      onChange={handleInputChange}
                      className="mt-1 block w-full border border-gray-300 rounded-md px-3 py-2 shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>

                  <div>
                    <label htmlFor="newPassword" className="block text-sm font-medium text-gray-700">
                      New Password
                    </label>
                    <input
                      type="password"
                      id="newPassword"
                      name="newPassword"
                      value={formData.newPassword}
                      onChange={handleInputChange}
                      className="mt-1 block w-full border border-gray-300 rounded-md px-3 py-2 shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>

                  <div>
                    <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700">
                      Confirm New Password
                    </label>
                    <input
                      type="password"
                      id="confirmPassword"
                      name="confirmPassword"
                      value={formData.confirmPassword}
                      onChange={handleInputChange}
                      className="mt-1 block w-full border border-gray-300 rounded-md px-3 py-2 shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>
                </div>
              </div>

              <div className="flex justify-end space-x-3 pt-6">
                <button
                  type="button"
                  onClick={handleCancel}
                  className="bg-white text-gray-700 px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>

      {/* API Tokens — named, revocable credentials for scripts & services.
          Actions performed with one are attributed by name in the audit log,
          unlike the session token. They carry the same permissions as you. */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <h2 className="text-lg font-medium text-gray-900">API Tokens</h2>
          <p className="mt-1 text-sm text-gray-600">
            Create named tokens to access the API from external services (parsers, scripts,
            the Python <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">PlaidClient</code>).
            Each token carries your permissions, never expires, and survives password changes —
            revoke one to cut off access. Actions taken with a token are labelled by its name in
            the audit history.
          </p>

          {tokensError && (
            <div className="mt-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
              {tokensError}
            </div>
          )}

          {/* One-time reveal of a freshly minted token */}
          {mintedToken && (
            <div className="mt-4 bg-amber-50 border border-amber-300 rounded-md p-4">
              <p className="text-sm font-medium text-amber-800">
                Token “{mintedToken.name}” created. Copy it now — you won’t be able to see it again.
              </p>
              <div className="mt-2 flex items-center space-x-2">
                <code className="flex-1 text-xs bg-white border border-amber-200 rounded px-2 py-1 break-all">
                  {mintedToken.token}
                </code>
                <button
                  onClick={handleCopyMinted}
                  className="shrink-0 px-3 py-1 bg-amber-600 text-white text-sm rounded-md hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2"
                >
                  {mintedCopied ? '✓ Copied!' : 'Copy'}
                </button>
                <button
                  onClick={() => setMintedToken(null)}
                  className="shrink-0 px-3 py-1 bg-white text-gray-700 text-sm border border-gray-300 rounded-md hover:bg-gray-50"
                >
                  Done
                </button>
              </div>
            </div>
          )}

          {/* Create form */}
          <form onSubmit={handleCreateToken} className="mt-4 flex items-end space-x-3">
            <div className="flex-1">
              <label htmlFor="new-token-name" className="block text-sm font-medium text-gray-700">
                New token name
              </label>
              <input
                type="text"
                id="new-token-name"
                value={newTokenName}
                onChange={(e) => setNewTokenName(e.target.value)}
                placeholder="e.g. Stanza Parser"
                className="mt-1 block w-full border border-gray-300 rounded-md px-3 py-2 shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <button
              type="submit"
              disabled={creatingToken}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {creatingToken ? 'Creating…' : 'Create Token'}
            </button>
          </form>

          {/* Token list */}
          <div className="mt-6">
            {tokensLoading ? (
              <p className="text-sm text-gray-500">Loading tokens…</p>
            ) : activeTokens.length === 0 ? (
              <p className="text-sm text-gray-500">You have no active API tokens.</p>
            ) : (
              <ul className="divide-y divide-gray-200 border-t border-gray-200">
                {activeTokens.map((t) => (
                  <li key={t.id} className="py-3 flex items-center justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{t.name}</p>
                      <p className="text-xs text-gray-500">
                        Created {t.createdAt ? new Date(t.createdAt).toLocaleString() : 'unknown'}
                      </p>
                    </div>
                    <button
                      onClick={() => handleRevokeToken(t.id)}
                      className="shrink-0 ml-4 text-sm text-red-600 hover:text-red-800"
                    >
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};