import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { ArrowLeft } from 'lucide-react';
import { notifySuccess, notifyError, notifyWarning } from '@/utils/feedback';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

const EMPTY = (username = '') => ({ username, currentPassword: '', newPassword: '', confirmPassword: '' });

export const UserProfile = () => {
  const navigate = useNavigate();
  const { user, client, updateUser } = useAuth();
  const [isEditing, setIsEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fields, setFields] = useState(EMPTY(user?.username));
  const [errors, setErrors] = useState({});

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
    </div>
  );
};
