import { nodeLabel } from '@/import/elan/schema';
import { t } from '@ui/lib/i18n.js';

/**
 * A tier row's name as the review shows it. nodeLabel's placeholder for a
 * tier with no name of its own stays English there, because it can become a
 * stored field name. Only what is drawn on screen is translated.
 */
export const shownNodeLabel = (node) => (node.baseName ? nodeLabel(node) : t('(speaker tier)'));
