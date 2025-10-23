import { Avatar, Menu, Button, Text, Group } from '@mantine/core';
import IconLogout from '@tabler/icons-react/dist/esm/icons/IconLogout.mjs';
import IconUser from '@tabler/icons-react/dist/esm/icons/IconUser.mjs';
import { useNavigate } from 'react-router-dom';

export function UserButton({ user, onLogout }) {
  const navigate = useNavigate();

  return (
    <Menu shadow="md" width={200}>
      <Menu.Target>
        <Button variant="subtle" p="xs" h="auto">
          <Group gap="xs" wrap="nowrap" align="center">
            <Avatar size={28} color="blue">
              {user.username.charAt(0).toUpperCase()}
            </Avatar>
            <div>
              <Text size="sm" fw={500} truncate lh={1.2}>
                {user.username}
              </Text>
              {/*user.isAdmin && (
                <Text size="xs" c="dimmed" lh={1}>
                  Admin
                </Text>
              )*/}
            </div>
          </Group>
        </Button>
      </Menu.Target>

      <Menu.Dropdown>
        <Menu.Label>Account</Menu.Label>
        <Menu.Item 
          leftSection={<IconUser size={14} />}
          onClick={() => navigate('/profile')}
        >
          Profile
        </Menu.Item>

        <Menu.Divider />
        
        <Menu.Item 
          color="red" 
          leftSection={<IconLogout size={14} />}
          onClick={onLogout}
        >
          Logout
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}