import { useMemo } from 'react';
import { getUdLayerInfo } from '../../../utils/udLayerUtils.js';

export const useLayerInfo = (document) => {
  return useMemo(() => getUdLayerInfo(document), [document]);
};
