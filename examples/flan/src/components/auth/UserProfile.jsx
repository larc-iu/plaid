import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { 
  Container, 
  Paper, 
  Title, 
  Text, 
  Button, 
  TextInput,
  PasswordInput,
  Stack,
  Group,
  Alert,
  Divider
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconArrowLeft } from '@tabler/icons-react';

export const UserProfile = () => {
  const navigate = useNavigate();
  const { user, getClient, updateUser } = useAuth();
  const [isEditing, setIsEditing] = useState(false);
  const [loading, setLoading] = useState(false);

  const form = useForm({
    initialValues: {
      username: user?.username || '',
      currentPassword: '',
      newPassword: '',
      confirmPassword: ''
    },
    validate: {
      username: (value) => value.trim().length < 1 ? 'Username is required' : null,
      newPassword: (value, values) => {
        if (value && value.length < 6) {
          return 'Password must be at least 6 characters long';
        }
        return null;
      },
      confirmPassword: (value, values) => {
        if (values.newPassword && value !== values.newPassword) {
          return 'Passwords do not match';
        }
        return null;
      },
      currentPassword: (value, values) => {
        if (values.newPassword && !value) {
          return 'Current password is required to change password';
        }
        return null;
      }
    }
  });

  const handleSubmit = async (values) => {
    setLoading(true);

    try {
      const client = getClient();
      
      if (!user.id) {
        throw new Error('Could not get current user ID');
      }

      const updateData = {};
      
      // Only include username if it changed
      if (values.username !== user.username) {
        updateData.username = values.username;
      }
      
      // Only include password if it's being changed
      if (values.newPassword) {
        updateData.password = values.newPassword;
      }

      // If no changes, don't make API call
      if (Object.keys(updateData).length === 0) {
        notifications.show({
          title: 'No Changes',
          message: 'No changes to save',
          color: 'yellow'
        });
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
      
      // Fetch updated user data from server
      const updatedUserData = await client.users.get(user.id);

      notifications.show({
        title: 'Success',
        message: 'Profile updated successfully!',
        color: 'green'
      });
      
      setIsEditing(false);
      
      // Clear password fields
      form.setValues({
        username: updatedUserData.username,
        currentPassword: '',
        newPassword: '',
        confirmPassword: ''
      });

      // Update localStorage and auth context
      localStorage.setItem('username', updatedUserData.username);
      localStorage.setItem('isAdmin', (updatedUserData.isAdmin || false).toString());
      
      // Update the auth context
      updateUser({ 
        username: updatedUserData.username,
        isAdmin: updatedUserData.isAdmin || false
      });
      
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err.message || 'Failed to update profile',
        color: 'red'
      });
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    setIsEditing(false);
    form.setValues({
      username: user?.username || '',
      currentPassword: '',
      newPassword: '',
      confirmPassword: ''
    });
    form.clearErrors();
  };

  return (
    <Container size="sm" py="xl">
      <Button 
        variant="subtle" 
        leftSection={<IconArrowLeft size={16} />}
        mb="md"
        onClick={() => navigate(-1)}
      >
        Back
      </Button>
      
      <Paper shadow="sm" p="xl" radius="md">
        <Stack spacing="lg">
          <Title order={2}>User Profile</Title>
          
          {!isEditing ? (
            <Stack spacing="md">
              <div>
                <Text size="sm" fw={500} c="dimmed" mb="xs">Username</Text>
                <Text size="lg">{user?.username}</Text>
              </div>
              
              <Button onClick={() => setIsEditing(true)} mt="md">
                Edit Profile
              </Button>
            </Stack>
          ) : (
            <form onSubmit={form.onSubmit(handleSubmit)}>
              <Stack spacing="md">
                <TextInput
                  label="Username"
                  placeholder="Enter username"
                  required
                  {...form.getInputProps('username')}
                />

                <Divider label="Change Password (Optional)" labelPosition="center" />
                
                <PasswordInput
                  label="Current Password"
                  placeholder="Enter current password"
                  {...form.getInputProps('currentPassword')}
                />

                <PasswordInput
                  label="New Password"
                  placeholder="Enter new password"
                  {...form.getInputProps('newPassword')}
                />

                <PasswordInput
                  label="Confirm New Password"
                  placeholder="Confirm new password"
                  {...form.getInputProps('confirmPassword')}
                />

                <Group justify="flex-end" mt="lg">
                  <Button variant="outline" onClick={handleCancel}>
                    Cancel
                  </Button>
                  <Button type="submit" loading={loading}>
                    Save Changes
                  </Button>
                </Group>
              </Stack>
            </form>
          )}
        </Stack>
      </Paper>
    </Container>
  );
};