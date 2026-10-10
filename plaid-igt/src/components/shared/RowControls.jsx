import { ChevronUp, ChevronDown, Trash2 } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { ROW_DELETE_CLASS } from '@ui/lib/destructive.js';

// A list row's move and remove buttons. Always visible, not on hover: a row
// whose controls appear only under the pointer reads as a fixed fact, and a
// keyboard never finds them. A remove that is not a delete (a reset) is
// `destructive={false}` and stays grey on hover. A handler left out leaves its buttons out. Clicks
// stop at the buttons, so a row that toggles on click is not toggled too.
export const RowControls = ({
  name,
  onUp,
  onDown,
  canUp = true,
  canDown = true,
  onRemove,
  canRemove = true,
  removeLabel = 'Remove',
  removeIcon: RemoveIcon = Trash2,
  destructive = true,
}) => {
  const press = (handler) => (event) => {
    event.stopPropagation();
    handler();
  };
  const named = (label) => (name ? `${label} ${name}` : label);
  return (
    <div className="flex items-center gap-1">
      {onUp && (
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={press(onUp)}
          disabled={!canUp}
          title="Move up"
          aria-label={name ? `Move ${name} up` : 'Move up'}
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
          title="Move down"
          aria-label={name ? `Move ${name} down` : 'Move down'}
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
          title={removeLabel}
          aria-label={named(removeLabel)}
        >
          <RemoveIcon className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
};
