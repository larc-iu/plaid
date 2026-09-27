import { cn } from '../../lib/utils.js';
import { NOTICE_TONES } from './noticeTones.js';

/**
 * A banner on a page or in a panel: a tinted, bordered box with an icon and a
 * line or two of text.
 *
 * Props:
 * - `tone`: `'info'` (default), `'warning'`, `'error'` or `'success'`. Sets
 *   the colours and the default icon.
 * - `icon`: a lucide component to show instead of the tone's own, or `null`
 *   for none.
 * - `className`: merged over the box's classes (margins, width).
 * - `children`: the text, and any inline link or button that goes with it.
 * - anything else (`role`, `data-testid`, `id`) goes on the box. It carries no
 *   role of its own: pass `role="alert"` where the notice appears in answer to
 *   something the reader just did and has to be announced.
 */
export const Notice = ({ tone = 'info', icon, className, children, ...rest }) => {
  const t = NOTICE_TONES[tone] ?? NOTICE_TONES.info;
  const Icon = icon === undefined ? t.icon : icon;
  return (
    <div
      data-tone={tone}
      className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-sm', t.box, className)}
      {...rest}
    >
      {Icon && <Icon aria-hidden="true" className={cn('mt-0.5 h-4 w-4 shrink-0', t.iconClass)} />}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
};
