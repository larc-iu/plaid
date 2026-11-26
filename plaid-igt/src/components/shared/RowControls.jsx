import { ChevronUp, ChevronDown, Trash2 } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { ROW_DELETE_CLASS } from '@ui/lib/destructive.js';
import { t } from '@ui/lib/i18n.js';

// A list row's move and remove buttons. Always visible, not on hover: a row
// whose controls appear only under the pointer reads as a fixed fact, and a
// keyboard never finds them. A remove that is not a delete (a reset) is
// `destructive={false}` and stays grey on hover. A handler left out leaves its buttons out. Clicks
// stop at the buttons, so a row that toggles on click is not toggled too.
//
// `name` names the row in the buttons' labels for a screen reader. The remove
// button's title is `removeLabel` ("Remove" by default), and its label names
// the row: `removeAria`, a whole message such as t('Unlink {name}', { name }).
// A `removeLabel` given without `removeAria` is put before the name, which
// only English reads right.
export const RowControls = ({
  name,
  onUp,
  onDown,
  canUp = true,
  canDown = true,
  onRemove,
  canRemove = true,
  removeLabel,
  removeAria,
  removeIcon: RemoveIcon = Trash2,
  destructive = true,
}) => {
  const press = (handler) => (event) => {
    event.stopPropagation();
    handler();
  };
  const removeTitle = removeLabel ?? t('Remove');
  const removeNamed =
    removeAria ??
    (removeLabel == null
      ? name
        ? t('Remove {name}', { name })
        : t('Remove')
      : name
        ? `${removeLabel} ${name}`
        : removeLabel);
  return (
    <div className="flex items-center gap-1">
      {onUp && (
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={press(onUp)}
          disabled={!canUp}
          title={t('Move up')}
          aria-label={name ? t('Move {name} up', { name }) : t('Move up')}
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </Button>
      )}
      {onDown && (
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={press(onDown)}
          disabled={!canDown}
          title={t('Move down')}
          aria-label={name ? t('Move {name} down', { name }) : t('Move down')}
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
      )}
      {onRemove && (
        <Button
          size="icon"
          variant="ghost"
          className={destructive ? `h-7 w-7 ${ROW_DELETE_CLASS}` : 'h-7 w-7'}
          onClick={press(onRemove)}
          disabled={!canRemove}
          title={removeTitle}
          aria-label={removeNamed}
        >
          <RemoveIcon className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
};
