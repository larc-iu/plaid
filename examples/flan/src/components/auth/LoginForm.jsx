import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { 
  Container, 
  Paper, 
  Title, 
  Text, 
  TextInput, 
  PasswordInput, 
  Button, 
  Alert, 
  Stack,
  Center
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';

export const LoginForm = () => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  
  const navigate = useNavigate();
  const { login } = useAuth();

  const form = useForm({
    initialValues: {
      username: '',
      password: ''
    },
    validate: {
      username: (value) => value.length === 0 ? 'Username is required' : null,
      password: (value) => value.length === 0 ? 'Password is required' : null
    }
  });

  const handleSubmit = async (values) => {
    setError('');
    setLoading(true);

    try {
      const result = await login(values.username, values.password);
      if (result.success) {
        notifications.show({
          title: 'Success',
          message: 'Login successful!',
          color: 'green'
        });
        navigate('/projects');
      } else {
        setError(result.error || 'Login failed. Please check your credentials.');
      }
    } catch (err) {
      setError('An unexpected error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Container size="sm" style={{ height: '100vh', display: 'flex', alignItems: 'center' }}>
      <Paper shadow="md" p="xl" radius="md" style={{ width: '100%' }}>
        <Stack spacing="md">
          <Center>
            <Stack spacing="xs" align="center">
              <Title order={1} size="h2">Flan Login</Title>
              <Text size="sm" color="dimmed">Plaid Annotation Interface</Text>
            </Stack>
          </Center>
          
          <form onSubmit={form.onSubmit(handleSubmit)}>
            <Stack spacing="md">
              {error && (
                <Alert color="red" title="Login Error">
                  {error}
                </Alert>
              )}
              
              <TextInput
                label="Username"
                placeholder="Enter your username"
                required
                disabled={loading}
                {...form.getInputProps('username')}
              />
              
              <PasswordInput
                label="Password"
                placeholder="Enter your password"
                required
                disabled={loading}
                {...form.getInputProps('password')}
              />
              
              <Button 
                type="submit" 
                loading={loading}
                fullWidth
                size="md"
                mt="sm"
              >
                {loading ? 'Logging in...' : 'Login'}
              </Button>
            </Stack>
          </form>
        </Stack>
      </Paper>
    </Container>
  );
};