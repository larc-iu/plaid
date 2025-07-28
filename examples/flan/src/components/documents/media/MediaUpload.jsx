import React from 'react';
import { useSnapshot } from 'valtio';
import {
  Stack,
  Text,
  Paper,
  Button,
  Center,
  FileButton
} from '@mantine/core';
import IconUpload from '@tabler/icons-react/dist/esm/icons/IconUpload.mjs';
import documentsStore from '../../../stores/documentsStore';

export const MediaUpload = ({ onUpload, isUploading, projectId, documentId }) => {
  const storeSnap = useSnapshot(documentsStore);
  const docSnap = storeSnap[projectId]?.[documentId];
  const isViewingHistorical = docSnap?.ui?.history?.viewingHistorical || false;
  
  return (
    <Paper withBorder p="xl">
      <Center>
        <Stack align="center" spacing="lg">
          <IconUpload size={48} color="#868e96" />
          <div style={{ textAlign: 'center' }}>
            <Text size="lg" fw={500} mb="xs">Upload Media File</Text>
            <Text size="sm" c="dimmed" mb="md">
              Upload an audio or video file to begin time-aligned transcription
            </Text>
          </div>
          
          <FileButton onChange={onUpload} accept="audio/*,video/*" disabled={isViewingHistorical}>
            {(props) => (
              <Button 
                {...props} 
                leftSection={<IconUpload size={16} />}
                loading={isUploading}
                size="lg"
                disabled={isViewingHistorical}
              >
                Choose Media File
              </Button>
            )}
          </FileButton>
          
          <Text size="xs" c="dimmed">
            Recommended formats: MP4, WebM, OGG, MOV (video) • MP3, WAV, M4A, AAC (audio)
          </Text>
        </Stack>
      </Center>
    </Paper>
  );
};