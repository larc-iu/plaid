// Where a document keeps the speech-detection cuts made on its recording
// (useVadProposals.js). They belong to that recording, so deleting it drops
// them (`deleteMedia`).
export const VAD_METADATA_KEY = 'speechDetection';
