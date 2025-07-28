import React from 'react';
import { useSnapshot } from 'valtio';
import {
  Stack,
  Text,
  Paper,
  Button,
  Group,
  Box,
  Select,
  Progress
} from '@mantine/core';
import IconMicrophone from '@tabler/icons-react/dist/esm/icons/IconMicrophone.mjs';
import { useMediaOperations } from './useMediaOperations.js';
import documentsStore from '../../../stores/documentsStore';
import { MediaPlayer } from './MediaPlayer.jsx';
import { Timeline } from './Timeline.jsx';
import { MediaUpload } from './MediaUpload.jsx';

export function DocumentMedia({ projectId, documentId, reload, client }) {
  const storeSnap = useSnapshot(documentsStore);
  const docSnap = storeSnap[projectId]?.[documentId];
  const isViewingHistorical = docSnap?.ui?.history?.viewingHistorical || false;
  
  // Use media operations hook
  const mediaOps = useMediaOperations(projectId, documentId, reload, client);

  // If no media, show upload interface
  if (!mediaOps.parsedDocument.document.mediaUrl) {
    return (
      <Stack spacing="lg">
        <MediaUpload 
          onUpload={mediaOps.handleMediaUpload} 
          isUploading={mediaOps.isUploading}
          projectId={projectId}
          documentId={documentId}
        />
      </Stack>
    );
  }

  return (
    <Stack spacing="lg" mb="400px">
      {/* Media Player */}
      <MediaPlayer mediaOps={mediaOps} />

      {/* Timeline */}
      <Box style={{ position: 'relative' }}>
        <Timeline
          projectId={projectId}
          documentId={documentId}
          reload={reload}
          client={client}
          mediaOps={mediaOps}
        />
      </Box>

      {/* ASR Controls */}
      <Paper withBorder p="md" style={{ backgroundColor: '#f8f9fa' }}>
        <Group justify="space-between" align="flex-end" mb="md">
          <Group align="flex-end" gap="sm">
            <Select
                label="Transcription Service"
                value={mediaOps.asrAlgorithm}
                onChange={mediaOps.handleAlgorithmChange}
                data={mediaOps.asrAlgorithmOptions}
                style={{ width: 280 }}
                onMouseEnter={mediaOps.handleAsrDropdownInteraction}
                disabled={isViewingHistorical}
            />

            <Button
                leftSection={<IconMicrophone size={16} />}
                onClick={mediaOps.handleTranscribe}
                loading={mediaOps.isProcessing}
                disabled={!mediaOps.isUsingAsrService || mediaOps.isProcessing || mediaOps.isUploading || isViewingHistorical}
            >
              Transcribe
            </Button>
          </Group>

          <Button
              variant="default"
              onClick={mediaOps.handleClearAlignments}
              disabled={mediaOps.isProcessing || mediaOps.isUploading || !mediaOps.alignmentTokens.length || isViewingHistorical}
          >
            Clear Alignments
          </Button>
        </Group>
        
        {/* Progress */}
        <Box style={{ minHeight: '80px' }}>
          {(mediaOps.isProcessing || mediaOps.isUploading) ? (
            <Stack spacing="sm">
              <Group>
                <IconMicrophone size={16} />
                <Text fw={500}>{mediaOps.progressMessage || 'Processing...'}</Text>
              </Group>
              <Progress value={mediaOps.progressPercent || mediaOps.transcriptionProgress} animated />
              <Text size="sm" c="dimmed">{mediaOps.currentOperation}</Text>
            </Stack>
          ) : (
            <Box style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Text size="sm" c="dimmed">
                {mediaOps.alignmentTokens.length > 0 
                  ? `${mediaOps.alignmentTokens.length} time alignments` 
                  : 'No time alignments yet'
                }
              </Text>
            </Box>
          )}
        </Box>
      </Paper>
    </Stack>
  );
};