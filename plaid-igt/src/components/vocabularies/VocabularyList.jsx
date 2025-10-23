import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { 
  Container, 
  Title, 
  Paper, 
  Text, 
  Button, 
  Stack,
  Alert,
  Loader,
  Center,
  Group,
  SimpleGrid
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import IconPlus from '@tabler/icons-react/dist/esm/icons/IconPlus.mjs';

export const VocabularyList = () => {
  const navigate = useNavigate();
  const [vocabularies, setVocabularies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { client, user, logout } = useAuth();

  const fetchVocabularies = async () => {
    try {
      setLoading(true);
      if (!client) {
        throw new Error('Not authenticated');
      }
      const vocabList = await client.vocabLayers.list();
      setVocabularies(vocabList);
      setError('');
    } catch (err) {
      if (err.message === 'Not authenticated' || err.status === 401) {
        logout();
        return;
      }
      setError('Failed to load vocabularies');
      console.error('Error fetching vocabularies:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchVocabularies();
  }, []);

  const handleVocabularyClick = (vocabularyId) => {
    navigate(`/vocabularies/${vocabularyId}`);
  };

  const handleCreateVocabulary = () => {
    navigate('/vocabularies/new');
  };

  if (loading) {
    return (
      <Container size="lg" py="xl">
        <Center>
          <Stack align="center" spacing="md">
            <Loader size="lg" />
            <Text>Loading vocabularies...</Text>
          </Stack>
        </Center>
      </Container>
    );
  }

  return (
    <Container size="lg" py="xl">
      <Stack spacing="xl">
        <Group justify="space-between">
          <div>
            <Title order={1}>Vocabularies</Title>
          </div>
          <Button 
            leftSection={<IconPlus size={16} />}
            onClick={handleCreateVocabulary}
          >
            New Vocabulary
          </Button>
        </Group>

        {error && (
          <Alert color="red" title="Error">
            {error}
          </Alert>
        )}

        {vocabularies.length === 0 ? (
          <Paper shadow="sm" p="xl" radius="md">
            <Center>
              <Stack align="center" spacing="md">
                <Text size="lg" color="dimmed">No vocabularies found</Text>
                <Text size="sm" color="dimmed">
                  Create your first vocabulary to get started.
                </Text>
              </Stack>
            </Center>
          </Paper>
        ) : (
          <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md">
            {vocabularies.map(vocabulary => (
              <Paper 
                key={vocabulary.id} 
                shadow="sm" 
                p="md" 
                radius="md"
                style={{ cursor: 'pointer' }}
                onClick={() => handleVocabularyClick(vocabulary.id)}
              >
                <Stack spacing="xs">
                  <Title order={4}>{vocabulary.name}</Title>
                  <Text size="sm" c="dimmed">
                    ID: {vocabulary.id}
                  </Text>
                  {vocabulary.maintainers && (
                    <Text size="sm" c="dimmed">
                      {vocabulary.maintainers.length} maintainer{vocabulary.maintainers.length !== 1 ? 's' : ''}
                    </Text>
                  )}
                </Stack>
              </Paper>
            ))}
          </SimpleGrid>
        )}
      </Stack>
    </Container>
  );
};