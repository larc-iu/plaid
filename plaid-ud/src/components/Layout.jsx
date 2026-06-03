import { Outlet, useNavigate, useLocation, Link } from 'react-router-dom';
import { Box, Container, Group, Title, Button } from '@mantine/core';
import { useAuth } from '../contexts/AuthContext';

export const Layout = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  // The annotation editor wants the full viewport width; every other screen is
  // constrained to a centered container.
  const isAnnotationEditor = location.pathname.includes('/annotate');

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <Box
        component="header"
        bg="white"
        style={{ borderBottom: '1px solid var(--mantine-color-gray-2)' }}
      >
        <Container size="xl">
          <Group justify="space-between" h={64}>
            <Title
              order={3}
              component={Link}
              to="/"
              c="inherit"
              style={{ textDecoration: 'none' }}
            >
              Plaid UD
            </Title>
            {user && (
              <Group gap="xs">
                <Button component={Link} to="/profile" variant="subtle" color="gray" size="sm">
                  👤 {user.username}
                </Button>
                <Button onClick={handleLogout} variant="subtle" color="gray" size="sm">
                  Logout
                </Button>
              </Group>
            )}
          </Group>
        </Container>
      </Box>

      <Box component="main" style={{ flex: 1 }}>
        {isAnnotationEditor ? (
          <Outlet />
        ) : (
          <Container size="xl" py="xl">
            <Outlet />
          </Container>
        )}
      </Box>
    </Box>
  );
};
