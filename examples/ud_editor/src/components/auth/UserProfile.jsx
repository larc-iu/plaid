import { useState } from 'react';
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
      console.log('Updating user with:', {
        userId: user.id,
        password: updateData.password ? '[HIDDEN]' : undefined,
        username: updateData.username || undefined
      });
      
      await client.users.update(
        user.id, 
        updateData.password || undefined,
        updateData.username || undefined,
        undefined // isAdmin - we don't change this here
      );
      
      console.log('User update successful');

      setSuccess('Profile updated successfully!');
      setIsEditing(false);
      
      // Clear password fields
      setFormData(prev => ({
        ...prev,
        currentPassword: '',
        newPassword: '',
        confirmPassword: ''
      }));

      // If username changed, update localStorage, auth context, and local state
      if (updateData.username) {
        localStorage.setItem('username', updateData.username);
        // Update the auth context with the new username
        updateUser({ username: updateData.username });
        // Update form data to reflect the new username
        setFormData(prev => ({
          ...prev,
          username: updateData.username
        }));
      }
      
    } catch (err) {
      console.error('Failed to update user profile:', err);
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

  return (
    <div className="max-w-2xl mx-auto">
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
    </div>
  );
};