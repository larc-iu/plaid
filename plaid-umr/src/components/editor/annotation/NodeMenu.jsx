import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@ui/components/ui/dropdown-menu';
import { keys } from '../../../lib/keymap.js';

// Every action of a node, on the mouse. The keyboard reaches all of these
// too, and the menu says with which key, so it teaches the shortcuts rather
// than competing with them. Both call one `runAction`, so a gesture cannot
// mean two different things depending on how it was reached.
//
// One menu per BLOCK, not per node: a document has hundreds of nodes and a
// menu each would be hundreds of Radix subscriptions. It hangs off an
// invisible trigger the block moves to wherever the menu was asked for (the
// pointer for a right-click, the button for a click on it).
//
// `fixed:canvas:Enter` is the concept editor's key: a positional key nobody
// can rebind, listed here the same as the rest. The chords are read in
// WORDS (Enter, Shift+Backspace) rather than as keycaps: a menu row is a
// sentence, and ⇧⌫ in the middle of one is a puzzle. The FIRST chord only:
// an action with two (Backspace and Delete) would otherwise print both and
// push the label into wrapping.
const ITEMS = [
  [
    ['node.concept', 'Edit concept', 'fixed:canvas:Enter'],
    ['node.relation', 'Relation to parent'],
    ['node.attributes', 'Attributes'],
    ['node.variable', 'Rename variable'],
  ],
  [
    ['node.anchor', 'Change anchor'],
    ['node.move', 'Move under another node'],
    ['node.reentrancy', 'Add a second parent'],
    ['node.earlier', 'Move earlier'],
    ['node.later', 'Move later'],
    ['node.root', 'Make this the root'],
  ],
  [
    ['node.coref', 'Coreference'],
    ['node.temporal', 'Temporal relation'],
    ['node.modal', 'Modal relation'],
  ],
  [
    ['node.delete', 'Delete relation to parent'],
    ['node.deleteNode', 'Delete node and all below it'],
  ],
];

export function NodeMenu({ at, disabled, onAction, onClose, onClosed }) {
  return (
    <DropdownMenu open={!!at} onOpenChange={(open) => !open && onClose()}>
      <DropdownMenuTrigger asChild>
        {/* Nothing to see: the node the menu is about is the node under it.
            Placed where the menu was asked for, so Radix flips and shifts it
            against the viewport from there. */}
        <span
          aria-hidden="true"
          className="umr-menu-anchor"
          style={{ left: `${at?.x ?? 0}px`, top: `${at?.y ?? 0}px` }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        // Seventeen rows is taller than the room under a node halfway down a
        // long sentence, and Radix places what it cannot fit rather than
        // shrinking it: with neither side big enough the menu simply ran off
        // the bottom and its last rows could not be reached. This is the
        // height it says is going spare, so the menu always fits and scrolls
        // inside itself instead.
        className="max-h-[var(--radix-dropdown-menu-content-available-height)] w-96 overflow-y-auto"
        collisionPadding={8}
        // Where focus goes when the menu closes, which Radix would
        // otherwise decide: back to that invisible anchor, blurring whatever
        // the action just opened. An inline editor COMMITS on blur, so that
        // would write the value it had only just offered to edit. The block
        // says instead (the editor if one opened, else the node), and this
        // is the only hook that runs AFTER the menu has really gone: the
        // exit animation keeps it mounted, and focused, past the click.
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onClosed();
        }}
      >
        {ITEMS.map((group, i) => (
          <div key={i}>
            {i > 0 && <DropdownMenuSeparator />}
            {group.map(([id, label, keyId]) => (
              <DropdownMenuItem key={id} disabled={!!disabled?.[id]} onSelect={() => onAction(id)}>
                <span className="whitespace-nowrap">{label}</span>
                <span className="ml-auto pl-6 font-mono text-[0.7rem] whitespace-nowrap text-muted-foreground">
                  {keys.words(keyId || id)}
                </span>
              </DropdownMenuItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
