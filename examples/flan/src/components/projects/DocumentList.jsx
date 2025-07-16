import { 
  Title, 
  Text, 
  Stack,
  Center
} from '@mantine/core';
import { DataTable } from 'mantine-datatable';
import { notifications } from '@mantine/notifications';

export const DocumentList = ({ documents }) => {
  const handleDocumentClick = (document) => {
    // TODO: Navigate to document editor/viewer
    notifications.show({
      title: 'Coming Soon',
      message: `Document "${document.name}" selected. Editor will be implemented later.`,
      color: 'blue'
    });
  };

  const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    return new Date(dateString).toLocaleDateString();
  };

  return (
    <Stack spacing="md" mt="md">
      <Title order={2} mb="md">Documents</Title>
      
      {documents.length === 0 ? (
        <Center py="xl">
          <Stack align="center" spacing="md">
            <Text size="lg" c="dimmed">No documents found</Text>
            <Text size="sm" c="dimmed">
              This project doesn't have any documents yet.
            </Text>
          </Stack>
        </Center>
      ) : (
        <DataTable
          textSelectionDisabled
          withTableBorder
          withRowBorders
          highlightOnHover
          columns={[
            { 
              accessor: 'name', 
              title: 'Document Name',
              width: '70%'
            },
            { 
              accessor: 'id', 
              title: 'ID',
              width: '30%',
              render: ({ id }) => (
                <Text size="sm" c="dimmed">{id}</Text>
              )
            }
          ]}
          records={documents.sort((a, b) => a.name.localeCompare(b.name))}
          onRowClick={({ record }) => handleDocumentClick(record)}
          sx={{
            '& tbody tr': {
              cursor: 'pointer'
            }
          }}
        />
      )}
    </Stack>
  );
};