import { Outlet, useNavigate, useLocation, Link } from 'react-router-dom';
import { Box, Container, Group, Title, Button } from '@mantine/core';
import { useAuth } from '../contexts/AuthContext';
import { UserAvatar } from './common/UserAvatar';

export const Layout = () => {
  const { user, getClient, logout } = useAuth();
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
            <Title order={3} component={Link} to="/" c="inherit" style={{ textDecoration: 'none' }}>
              Plaid UD
            </Title>
            {user && (
              <Group gap="xs">
                {user.isAdmin && (
                  <Button
                    component={Link}
                    to="/admin/users"
                    variant="subtle"
                    color="gray"
                    size="sm"
                  >
                    Users
                  </Button>
                )}
                <Button
                  component={Link}
                  to="/profile"
                  variant="subtle"
                  color="gray"
                  size="sm"
                  leftSection={
                    <UserAvatar
                      client={getClient()}
                      userId={user.id}
                      displayName={user.displayName}
                      avatarHash={user.avatarHash}
                      size={22}
                    />
                  }
                >
                  {user.displayName}
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
        {/* One Container that changes shape, never a `cond ? <Outlet/> :
            <Container><Outlet/></Container>`. Swapping the element AT this
            position would unmount everything below it when you move into or out
            of /annotate — which is exactly the remount DocumentEditorShell
            exists to prevent, since the shell renders through this Outlet. */}
        <Container
          size={isAnnotationEditor ? undefined : 'xl'}
          fluid={isAnnotationEditor}
          px={isAnnotationEditor ? 0 : undefined}
          py={isAnnotationEditor ? 0 : 'xl'}
        >
          <Outlet />
        </Container>
      </Box>
    </Box>
  );
};
