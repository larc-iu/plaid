import { Input } from '@ui/components/ui/input';

// One labelled color, as a native swatch beside its hex. Replaces Mantine's
// ColorInput.
//
// The swatch is `<input type="color">`, which is the OS picker and needs no
// library. The text box beside it accepts a hex directly and, emptied, clears
// the override so the label falls back to its automatic color — which is why
// the two are not one control.
export const ColorField = ({ label, value, onChange }) => (
  <div className="flex flex-col gap-1">
    <span className="text-xs text-muted-foreground">{label}</span>
    <div className="flex items-center gap-1.5">
      <input
        type="color"
        className="h-8 w-8 shrink-0 cursor-pointer rounded border bg-transparent p-0.5"
        value={value || '#000000'}
        aria-label={`${label} color`}
        onChange={(e) => onChange(e.target.value)}
      />
      <Input
        className="h-8 font-mono text-xs"
        value={value || ''}
        spellCheck={false}
        placeholder="auto"
        aria-label={`${label} hex`}
        onChange={(e) => onChange(e.target.value.trim())}
      />
    </div>
  </div>
);
