import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Center, Stack, Paper, Title, Text, TextInput, PasswordInput, Button, Alert } from '@mantine/core';
import { useAuth } from '../../contexts/AuthContext';

export const LoginForm = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const navigate = useNavigate();
  const { login } = useAuth();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const result = await login(username, password);
      if (result.success) {
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
    <Center mih="100vh" bg="gray.0" p="md">
      <Stack w="100%" maw={400} gap="xl">
        <div>
          <Title order={1} ta="center">Plaid UD Login</Title>
          <Text c="dimmed" ta="center" size="sm" mt="xs">Universal Dependencies Tree Editor</Text>
        </div>

        <Paper withBorder shadow="sm" p="xl" radius="md">
          <form onSubmit={handleSubmit}>
            <Stack gap="md">
              {error && <Alert color="red">{error}</Alert>}

              <TextInput
                label="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                disabled={loading}
                data-autofocus
              />

              <PasswordInput
                label="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={loading}
              />

              <Button type="submit" color="dark" fullWidth loading={loading}>
                Login
              </Button>
            </Stack>
          </form>
        </Paper>
      </Stack>
    </Center>
  );
};
