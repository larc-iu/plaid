import { useState } from 'react';
import { 
  Stack, 
  Title, 
  Text, 
  Paper,
  Button,
  Group,
  Alert,
  Divider,
  Badge,
  Tabs,
  Select,
  ActionIcon,
  Tooltip,
  SimpleGrid
} from '@mantine/core';
import IconInfoCircle from '@tabler/icons-react/dist/esm/icons/IconInfoCircle.mjs';
import IconFileText from '@tabler/icons-react/dist/esm/icons/IconFileText.mjs';
import IconLetterA from '@tabler/icons-react/dist/esm/icons/IconLetterA.mjs';
import IconRefresh from '@tabler/icons-react/dist/esm/icons/IconRefresh.mjs';
import IconPlayerPlay from '@tabler/icons-react/dist/esm/icons/IconPlayerPlay.mjs';
import IconSettings from '@tabler/icons-react/dist/esm/icons/IconSettings.mjs';

export const DocumentAnalyze = ({ document, parsedDocument, project, client }) => {
  const [activeView, setActiveView] = useState('sentence');
  const [selectedField, setSelectedField] = useState('');
  const [processing, setProcessing] = useState(false);

  // Get annotation fields from project configuration
  const spanLayers = project?.textLayers
    ?.find(layer => layer.config?.flan?.primary)
    ?.tokenLayers?.find(layer => layer.config?.flan?.primary)
    ?.spanLayers || [];

  const sentenceFields = spanLayers.filter(layer => layer.config?.flan?.scope === 'Sentence');
  const tokenFields = spanLayers.filter(layer => layer.config?.flan?.scope === 'Token');

  const handleAutoTokenize = async () => {
    setProcessing(true);
    try {
      // TODO: Implement auto-tokenization when we discuss server response parsing
      console.log('Auto-tokenizing document...');
      
      // Simulate API call
      await new Promise(resolve => setTimeout(resolve, 2000));
      
    } catch (error) {
      console.error('Failed to auto-tokenize:', error);
    } finally {
      setProcessing(false);
    }
  };

  const handleAutoSegment = async () => {
    setProcessing(true);
    try {
      // TODO: Implement auto-segmentation when we discuss server response parsing
      console.log('Auto-segmenting sentences...');
      
      // Simulate API call
      await new Promise(resolve => setTimeout(resolve, 2000));
      
    } catch (error) {
      console.error('Failed to auto-segment:', error);
    } finally {
      setProcessing(false);
    }
  };

  const availableFields = activeView === 'sentence' ? sentenceFields : tokenFields;

  return (
    <Stack spacing="lg" mt="md">
      {/* Analysis Controls */}
      <Paper withBorder p="md">
        <Stack spacing="md">
          <Group justify="space-between" align="center">
            <div>
              <Title order={3}>Analysis Tools</Title>
              <Text size="sm" c="dimmed">
                Automated processing and annotation tools
              </Text>
            </div>
          </Group>

          <Divider />

          <SimpleGrid cols={2} spacing="md">
            <Button
              leftSection={<IconLetterA size={16} />}
              variant="light"
              onClick={handleAutoTokenize}
              loading={processing}
              disabled={processing}
            >
              Auto-Tokenize
            </Button>
            <Button
              leftSection={<IconFileText size={16} />}
              variant="light"
              onClick={handleAutoSegment}
              loading={processing}
              disabled={processing}
            >
              Auto-Segment Sentences
            </Button>
          </SimpleGrid>

          <Alert icon={<IconInfoCircle size={16} />} color="blue">
            <Text size="sm">
              Use these tools to automatically tokenize text and segment sentences. 
              You can then manually review and adjust the results.
            </Text>
          </Alert>
        </Stack>
      </Paper>

      {/* Annotation Interface */}
      <Paper withBorder p="md">
        <Stack spacing="md">
          <Group justify="space-between" align="center">
            <div>
              <Title order={3}>Annotation Interface</Title>
              <Text size="sm" c="dimmed">
                Annotate tokens and sentences with linguistic information
              </Text>
            </div>
            <Group>
              <Tooltip label="Refresh annotations">
                <ActionIcon variant="light" onClick={() => console.log('Refresh annotations')}>
                  <IconRefresh size={16} />
                </ActionIcon>
              </Tooltip>
            </Group>
          </Group>

          <Divider />

          <Tabs value={activeView} onChange={setActiveView}>
            <Tabs.List>
              <Tabs.Tab value="sentence" leftSection={<IconFileText size={16} />}>
                Sentence Level
              </Tabs.Tab>
              <Tabs.Tab value="token" leftSection={<IconLetterA size={16} />}>
                Token Level
              </Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel value="sentence">
              <Stack spacing="md" mt="md">
                <Group>
                  <Select
                    label="Annotation Field"
                    placeholder="Select field to annotate"
                    data={sentenceFields.map(field => ({
                      value: field.id,
                      label: field.name
                    }))}
                    value={selectedField}
                    onChange={setSelectedField}
                    style={{ flex: 1 }}
                  />
                </Group>

                {sentenceFields.length === 0 && (
                  <Alert icon={<IconInfoCircle size={16} />} color="yellow">
                    No sentence-level annotation fields configured for this project.
                  </Alert>
                )}

                <Paper bg="gray.0" p="md" radius="md" mih={200}>
                  <Text size="sm" c="dimmed" ta="center" mt="xl">
                    {/* TODO: Render sentence annotation interface when we discuss server response parsing */}
                    Sentence annotation interface will be rendered here...
                  </Text>
                </Paper>
              </Stack>
            </Tabs.Panel>

            <Tabs.Panel value="token">
              <Stack spacing="md" mt="md">
                <Group>
                  <Select
                    label="Annotation Field"
                    placeholder="Select field to annotate"
                    data={tokenFields.map(field => ({
                      value: field.id,
                      label: field.name
                    }))}
                    value={selectedField}
                    onChange={setSelectedField}
                    style={{ flex: 1 }}
                  />
                </Group>

                {tokenFields.length === 0 && (
                  <Alert icon={<IconInfoCircle size={16} />} color="yellow">
                    No token-level annotation fields configured for this project.
                  </Alert>
                )}

                <Paper bg="gray.0" p="md" radius="md" mih={200}>
                  <Text size="sm" c="dimmed" ta="center" mt="xl">
                    {/* TODO: Render token annotation interface when we discuss server response parsing */}
                    Token annotation interface will be rendered here...
                  </Text>
                </Paper>
              </Stack>
            </Tabs.Panel>
          </Tabs>
        </Stack>
      </Paper>

      {/* Statistics */}
      <Paper withBorder p="md">
        <Stack spacing="md">
          <Title order={4}>Document Statistics</Title>
          <Divider />
          <SimpleGrid cols={3} spacing="md">
            <div>
              <Text size="sm" c="dimmed">Sentences</Text>
              <Text size="xl" fw={600}>
                {parsedDocument?.sentences?.length || 0}
              </Text>
            </div>
            <div>
              <Text size="sm" c="dimmed">Tokens</Text>
              <Text size="xl" fw={600}>
                {parsedDocument?.sentences?.reduce((total, sentence) => 
                  total + (sentence.tokens?.length || 0), 0) || 0}
              </Text>
            </div>
            <div>
              <Text size="sm" c="dimmed">Annotations</Text>
              <Text size="xl" fw={600}>
                {parsedDocument?.sentences?.reduce((total, sentence) => {
                  const sentenceAnnotations = Object.keys(sentence.annotations || {}).length;
                  const tokenAnnotations = (sentence.tokens || []).reduce((tokenTotal, token) => 
                    tokenTotal + Object.keys(token.annotations || {}).length, 0);
                  return total + sentenceAnnotations + tokenAnnotations;
                }, 0) || 0}
              </Text>
            </div>
          </SimpleGrid>
        </Stack>
      </Paper>
    </Stack>
  );
};