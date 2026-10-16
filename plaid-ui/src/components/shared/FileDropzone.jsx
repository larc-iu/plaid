import { useRef, useState } from 'react';
import { cn } from '../../lib/utils.js';

/**
 * The dashed box a file is dropped on, with a hidden file input behind it, for
 * every app's import screens. `onFiles` is given the files as an array, and
 * only when there is one. `dragging` is counted rather than set, because
 * dragging over a child element fires dragleave on the parent and a boolean
 * would flicker. It is a button to the keyboard: a stop in the tab order that
 * Enter and Space open the file picker from.
 *
 * With `clickable` false the box only takes a drop: its children hold the
 * button that opens the page's own input (a page that keeps its input, to add
 * files later), and a button inside a button is not one a reader can reach.
 */
export const FileDropzone = ({
  onFiles,
  disabled = false,
  accept,
  multiple = true,
  clickable = true,
  className,
  children,
}) => {
  const [depth, setDepth] = useState(0);
  const inputRef = useRef(null);

  const take = (list) => {
    const files = [...(list || [])];
    if (files.length) onFiles(files);
  };
  const open = () => inputRef.current?.click();

  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? (disabled ? -1 : 0) : undefined}
      aria-disabled={(clickable && disabled) || undefined}
      className={cn(
        'flex min-h-[120px] flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-6 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        clickable && 'cursor-pointer',
        depth > 0 ? 'border-primary bg-primary/5' : clickable && 'hover:bg-muted/40',
        disabled && 'pointer-events-none opacity-50',
        className,
      )}
      onClick={clickable ? open : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (disabled || e.target !== e.currentTarget) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                open();
              }
            }
          : undefined
      }
      onDragEnter={(e) => {
        e.preventDefault();
        setDepth((d) => d + 1);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => setDepth((d) => Math.max(0, d - 1))}
      onDrop={(e) => {
        e.preventDefault();
        setDepth(0);
        if (!disabled) take(e.dataTransfer?.files);
      }}
    >
      {clickable && (
        <input
          ref={inputRef}
          type="file"
          multiple={multiple}
          accept={accept}
          className="hidden"
          disabled={disabled}
          onChange={(e) => {
            take(e.target.files);
            // Let the same file be picked twice in a row.
            e.target.value = '';
          }}
        />
      )}
      {children}
    </div>
  );
};
