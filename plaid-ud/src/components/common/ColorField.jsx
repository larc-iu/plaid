import { Input } from '@ui/components/ui/input';
import { cn } from '@ui/lib/utils';
import { isHexColor } from '../../utils/udVocab.js';

// One labelled color, as a native swatch beside its hex. Replaces Mantine's
// ColorInput.
//
// The swatch is `<input type="color">`, which is the OS picker and needs no
// library. The text box beside it accepts a hex directly and, emptied, clears
// the override so the label falls back to its automatic color, which is why
// the two are not one control.
//
// `value` is the override alone, '' for none, and `auto` the color the label
// gets without one. The box shows the override and the automatic color only as
// its placeholder: filling an emptied box with the automatic color made the
// next hex typed append to it (H18-2). A hex that is not a color is marked, and
// Save refuses it.
export const ColorField = ({ label, value, auto, onChange }) => {
  const valid = isHexColor(value);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          className="h-8 w-8 shrink-0 cursor-pointer rounded border bg-transparent p-0.5"
          value={valid ? value.toLowerCase() : auto}
          aria-label={`${label} color`}
          onChange={(e) => onChange(e.target.value)}
        />
        <Input
          className={cn('h-8 font-mono text-xs', value && !valid && 'border-destructive')}
          value={value || ''}
          spellCheck={false}
          placeholder={auto}
          aria-label={`${label} hex`}
          aria-invalid={value && !valid ? true : undefined}
          onChange={(e) => onChange(e.target.value.trim())}
        />
      </div>
    </div>
  );
};
