import { useMemo } from 'react';

export const useLayerInfo = (document) => {
  return useMemo(() => {
    if (!document) return {};
    
    const textLayer = document.textLayers?.[0];
    const tokenLayer = textLayer?.tokenLayers?.[0];
    const spanLayers = tokenLayer?.spanLayers || [];
    
    const lemmaLayer = spanLayers.find(layer => layer.name === 'Lemma');
    const uposLayer = spanLayers.find(layer => layer.name === 'UPOS');
    const xposLayer = spanLayers.find(layer => layer.name === 'XPOS');
    const featuresLayer = spanLayers.find(layer => layer.name === 'Features');
    
    // Get relation layer (attached to lemma layer)
    const relationLayer = lemmaLayer?.relationLayers?.[0];
    
    return {
      lemmaLayer,
      uposLayer,
      xposLayer,
      featuresLayer,
      relationLayer,
      textLayer,
      tokenLayer
    };
  }, [document]);
};