import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { authService } from '../../services/auth';

export const ProjectManagement = () => {
  const { projectId } = useParams();
  const { user, getClient, updateUser } = useAuth();
  const [project, setProject] = useState(null);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  
  // User creation form state
  const [showCreateUserForm, setShowCreateUserForm] = useState(false);
  const [newUserForm, setNewUserForm] = useState({
    username: '',
    password: '',
    confirmPassword: '',
    isAdmin: false
  });
  const [createUserError, setCreateUserError] = useState('');
  const [createUserLoading, setCreateUserLoading] = useState(false);
  
  // Token copy state
  const [tokenCopied, setTokenCopied] = useState(false);
  
  // User editing state
  const [editingUser, setEditingUser] = useState(null);
  const [editUserForm, setEditUserForm] = useState({
    username: '',
    password: '',
    confirmPassword: '',
    isAdmin: false
  });

  const isAdmin = user?.isAdmin || false;

  const fetchData = async () => {
    try {
      setLoading(true);
      const client = getClient();
      
      // Fetch project details
      const projectData = await client.projects.get(projectId);
      setProject(projectData);
      
      // Fetch all users
      const usersData = await client.users.list();
      setUsers(usersData);
      
      setError('');
    } catch (err) {
      console.error('Error fetching data:', err);
      setError('Failed to load project data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [projectId]);

  // Check if current user can manage this project
  const canManageProject = () => {
    if (!user || !project) return false;
    return isAdmin || project.maintainers?.includes(user.id);
  };

  // Get user's current permission level for the project
  const getUserPermissionLevel = (userId) => {
    if (!project) return 'none';
    if (project.maintainers?.includes(userId)) return 'maintainer';
    if (project.writers?.includes(userId)) return 'writer';
    if (project.readers?.includes(userId)) return 'reader';
    return 'none';
  };

  // Handle permission change
  const handlePermissionChange = async (userId, newLevel) => {
    try {
      const client = getClient();
      const currentLevel = getUserPermissionLevel(userId);
      
      // Remove current permission if any
      if (currentLevel === 'maintainer') {
        await client.projects.removeMaintainer(projectId, userId);
      } else if (currentLevel === 'writer') {
        await client.projects.removeWriter(projectId, userId);
      } else if (currentLevel === 'reader') {
        await client.projects.removeReader(projectId, userId);
      }
      
      // Add new permission if not 'none'
      if (newLevel === 'maintainer') {
        await client.projects.addMaintainer(projectId, userId);
      } else if (newLevel === 'writer') {
        await client.projects.addWriter(projectId, userId);
      } else if (newLevel === 'reader') {
        await client.projects.addReader(projectId, userId);
      }
      
      setSuccess('User permissions updated successfully');
      await fetchData(); // Refresh data
    } catch (err) {
      console.error('Error updating permissions:', err);
      setError('Failed to update user permissions');
    }
  };

  // Handle user creation
  const handleCreateUser = async (e) => {
    e.preventDefault();
    setCreateUserError('');
    setCreateUserLoading(true);

    if (newUserForm.password !== newUserForm.confirmPassword) {
      setCreateUserError('Passwords do not match');
      setCreateUserLoading(false);
      return;
    }

    if (newUserForm.password.length < 6) {
      setCreateUserError('Password must be at least 6 characters long');
      setCreateUserLoading(false);
      return;
    }

    try {
      const client = getClient();
      await client.users.create(
        newUserForm.username,
        newUserForm.password,
        newUserForm.isAdmin
      );
      
      // Success - close modal and show success on main page
      setSuccess('User created successfully');
      setShowCreateUserForm(false);
      setNewUserForm({
        username: '',
        password: '',
        confirmPassword: '',
        isAdmin: false
      });
      setCreateUserError('');
      await fetchData(); // Refresh users list
    } catch (err) {
      console.error('Error creating user:', err);
      
      // Check for specific error types and show error in modal
      if (err.status === 409 || (err.message && err.message.includes('409'))) {
        setCreateUserError(`A user with the ID "${newUserForm.username}" already exists. Please choose a different user ID.`);
      } else {
        setCreateUserError('Failed to create user: ' + (err.message || 'Unknown error'));
      }
    } finally {
      setCreateUserLoading(false);
    }
  };

  // Handle user editing
  const startEditingUser = (userToEdit) => {
    setEditingUser(userToEdit);
    setEditUserForm({
      username: userToEdit.username,
      password: '',
      confirmPassword: '',
      isAdmin: userToEdit.isAdmin || false
    });
  };

  const handleUpdateUser = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (editUserForm.password && editUserForm.password !== editUserForm.confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (editUserForm.password && editUserForm.password.length < 6) {
      setError('Password must be at least 6 characters long');
      return;
    }

    try {
      const client = getClient();
      const updateData = {};
      
      if (editUserForm.username !== editingUser.username) {
        updateData.username = editUserForm.username;
      }
      
      if (editUserForm.password) {
        updateData.password = editUserForm.password;
      }
      
      if (editUserForm.isAdmin !== (editingUser.isAdmin || false)) {
        updateData.isAdmin = editUserForm.isAdmin;
      }

      await client.users.update(
        editingUser.id,
        updateData.password,
        updateData.username,
        updateData.isAdmin
      );
      
      setSuccess('User updated successfully');
      setEditingUser(null);
      setEditUserForm({
        username: '',
        password: '',
        confirmPassword: '',
        isAdmin: false
      });
      await fetchData(); // Refresh users list
    } catch (err) {
      console.error('Error updating user:', err);
      setError('Failed to update user: ' + (err.message || 'Unknown error'));
    }
  };

  const handleDeleteUser = async () => {
    if (!confirm(`Are you sure you want to delete user "${editingUser.username}"? This action cannot be undone.`)) {
      return;
    }

    try {
      const client = getClient();
      await client.users.delete(editingUser.id);
      
      setSuccess('User deleted successfully');
      setEditingUser(null);
      await fetchData(); // Refresh users list
    } catch (err) {
      console.error('Error deleting user:', err);
      setError('Failed to delete user: ' + (err.message || 'Unknown error'));
    }
  };

  // Handle copying token to clipboard
  const handleCopyToken = async () => {
    try {
      const token = authService.getToken();
      if (token) {
        await navigator.clipboard.writeText(token);
        setTokenCopied(true);
        setTimeout(() => setTokenCopied(false), 2000); // Reset after 2 seconds
      }
    } catch (err) {
      console.error('Failed to copy token:', err);
      setError('Failed to copy token to clipboard');
    }
  };

  if (loading) {
    return <div className="text-center text-gray-600 py-8">Loading project management...</div>;
  }

  if (!project) {
    return (
      <div className="rounded-md bg-red-50 p-4">
        <p className="text-sm text-red-800">Project not found</p>
      </div>
    );
  }

  if (!canManageProject()) {
    return (
      <div className="rounded-md bg-red-50 p-4">
        <p className="text-sm text-red-800">You don't have permission to manage this project</p>
      </div>
    );
  }

  return (
    <div>
      <nav className="flex items-center text-sm text-gray-500 mb-6">
        <Link to="/projects" className="text-blue-600 hover:text-blue-800">Projects</Link>
        <span className="mx-2">/</span>
        <Link 
          to={`/projects/${projectId}/documents`} 
          className="text-blue-600 hover:text-blue-800"
        >
          {project.name}
        </Link>
        <span className="mx-2">/</span>
        <span className="text-gray-900">Project Management</span>
      </nav>

      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Project Management</h2>
        <p className="text-gray-600">Manage users and permissions for {project.name}</p>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 p-4 mb-4">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {success && (
        <div className="rounded-md bg-green-50 p-4 mb-4">
          <p className="text-sm text-green-800">{success}</p>
        </div>
      )}


      {/* User Creation Form (Admin Only) */}
      {isAdmin && !showCreateUserForm && (
        <div className="mb-6">
          <button
            onClick={() => {
              setShowCreateUserForm(true);
              setCreateUserError('');
            }}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
          >
            + Create User
          </button>
        </div>
      )}

      {isAdmin && showCreateUserForm && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-75 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-96 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-lg font-medium text-gray-900">Create New User</h3>
                <button
                  onClick={() => {
                    setShowCreateUserForm(false);
                    setCreateUserError('');
                  }}
                  className="text-gray-400 hover:text-gray-600"
                >
                  ✕
                </button>
              </div>

              {createUserError && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4">
                  {createUserError}
                </div>
              )}
              
              <form onSubmit={handleCreateUser} className="space-y-4">
                <div>
                  <label htmlFor="new-username" className="block text-sm font-medium text-gray-700">
                    User ID
                  </label>
                  <input
                    type="text"
                    id="new-username"
                    value={newUserForm.username}
                    onChange={(e) => setNewUserForm(prev => ({...prev, username: e.target.value}))}
                    className="mt-1 block w-full border border-gray-300 rounded-md px-3 py-2 shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                    required
                    placeholder="e.g., john.doe"
                  />
                  <p className="mt-1 text-xs text-gray-500">Unique identifier for this user (cannot be changed later)</p>
                </div>

                <div>
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={newUserForm.isAdmin}
                      onChange={(e) => setNewUserForm(prev => ({...prev, isAdmin: e.target.checked}))}
                      className="mr-2"
                    />
                    <span className="text-sm font-medium text-gray-700">Admin User</span>
                  </label>
                </div>

                <div>
                  <label htmlFor="new-password" className="block text-sm font-medium text-gray-700">
                    Password
                  </label>
                  <input
                    type="password"
                    id="new-password"
                    value={newUserForm.password}
                    onChange={(e) => setNewUserForm(prev => ({...prev, password: e.target.value}))}
                    className="mt-1 block w-full border border-gray-300 rounded-md px-3 py-2 shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                    required
                  />
                </div>

                <div>
                  <label htmlFor="new-confirm-password" className="block text-sm font-medium text-gray-700">
                    Confirm Password
                  </label>
                  <input
                    type="password"
                    id="new-confirm-password"
                    value={newUserForm.confirmPassword}
                    onChange={(e) => setNewUserForm(prev => ({...prev, confirmPassword: e.target.value}))}
                    className="mt-1 block w-full border border-gray-300 rounded-md px-3 py-2 shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                    required
                  />
                </div>

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={createUserLoading}
                  className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {createUserLoading ? 'Creating...' : 'Create User'}
                </button>
              </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Users and Permissions Management */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-medium text-gray-900">User Permissions</h3>
        </div>
        
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  User
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Role
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Project Permission
                </th>
                {isAdmin && (
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {users.map(userItem => (
                <tr key={userItem.id}>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div>
                      <div className="text-sm font-medium text-gray-900">{userItem.username}</div>
                      <div className="text-sm text-gray-500">ID: {userItem.id}</div>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                      userItem.isAdmin 
                        ? 'bg-purple-100 text-purple-800' 
                        : 'bg-gray-100 text-gray-800'
                    }`}>
                      {userItem.isAdmin ? 'Admin' : 'User'}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <select
                      value={getUserPermissionLevel(userItem.id)}
                      onChange={(e) => handlePermissionChange(userItem.id, e.target.value)}
                      className="text-sm border border-gray-300 rounded-md px-3 py-1 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                      disabled={userItem.id === user.id} // Can't change own permissions
                    >
                      <option value="none">None</option>
                      <option value="reader">Reader</option>
                      <option value="writer">Writer</option>
                      <option value="maintainer">Maintainer</option>
                    </select>
                    {userItem.id === user.id && (
                      <div className="text-xs text-gray-500 mt-1">Cannot change own permissions</div>
                    )}
                  </td>
                  {isAdmin && (
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      <button
                        onClick={() => startEditingUser(userItem)}
                        className="text-blue-600 hover:text-blue-800 mr-3"
                      >
                        Edit
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* API Access Section */}
      <div className="bg-white shadow rounded-lg mt-6">
        <div className="px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-medium text-gray-900">API Access</h3>
        </div>
        <div className="px-6 py-4">
          <p className="text-sm text-gray-600 mb-4">
            Use your authentication token to access the API programmatically from external services like parsers or scripts.
          </p>
          <div className="flex items-center space-x-3">
            <button
              onClick={handleCopyToken}
              className="px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2"
            >
              {tokenCopied ? '✓ Copied!' : 'Copy Your Token'}
            </button>
            {tokenCopied && (
              <span className="text-sm text-green-600">Token copied to clipboard</span>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Keep your token secure. You can use it to initialize a Python <pre style={{display: "inline"}}>PlaidClient</pre> instance.
          </p>
        </div>
      </div>

      {/* Edit User Modal */}
      {editingUser && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-75 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-96 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <h3 className="text-lg font-medium text-gray-900 mb-4">
                Edit User: {editingUser.username}
              </h3>
              
              <form onSubmit={handleUpdateUser} className="space-y-4">
                <div>
                  <label htmlFor="edit-username" className="block text-sm font-medium text-gray-700">
                    Username
                  </label>
                  <input
                    type="text"
                    id="edit-username"
                    value={editUserForm.username}
                    onChange={(e) => setEditUserForm(prev => ({...prev, username: e.target.value}))}
                    className="mt-1 block w-full border border-gray-300 rounded-md px-3 py-2 shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                    required
                  />
                </div>

                <div>
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={editUserForm.isAdmin}
                      onChange={(e) => setEditUserForm(prev => ({...prev, isAdmin: e.target.checked}))}
                      className="mr-2"
                    />
                    <span className="text-sm font-medium text-gray-700">Admin User</span>
                  </label>
                </div>

                <div>
                  <label htmlFor="edit-password" className="block text-sm font-medium text-gray-700">
                    New Password (leave blank to keep current)
                  </label>
                  <input
                    type="password"
                    id="edit-password"
                    value={editUserForm.password}
                    onChange={(e) => setEditUserForm(prev => ({...prev, password: e.target.value}))}
                    className="mt-1 block w-full border border-gray-300 rounded-md px-3 py-2 shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>

                <div>
                  <label htmlFor="edit-confirm-password" className="block text-sm font-medium text-gray-700">
                    Confirm New Password
                  </label>
                  <input
                    type="password"
                    id="edit-confirm-password"
                    value={editUserForm.confirmPassword}
                    onChange={(e) => setEditUserForm(prev => ({...prev, confirmPassword: e.target.value}))}
                    className="mt-1 block w-full border border-gray-300 rounded-md px-3 py-2 shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>

                <div className="flex justify-between pt-4">
                  <button
                    type="button"
                    onClick={handleDeleteUser}
                    className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
                    disabled={editingUser.id === user.id} // Can't delete yourself
                  >
                    Delete User
                  </button>
                  <div className="flex space-x-3">
                    <button
                      type="button"
                      onClick={() => setEditingUser(null)}
                      className="px-4 py-2 bg-gray-300 text-gray-700 rounded-md hover:bg-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                    >
                      Update User
                    </button>
                  </div>
                </div>
                {editingUser.id === user.id && (
                  <p className="text-xs text-gray-500 mt-2">You cannot delete your own account</p>
                )}
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};