import { useId } from 'react';
import { formatBytes } from '@/utils/formatBytes';
import { SMALL_RATE } from '@/domain/media/mixdown';

// The quality a WAV made in the browser is written at, asked where it is
// made: in the mix dialog, and in the channel speakers dialog for a file it
// makes a WAV. "Full quality" is at `fullRate` (null until it is known),
// "Smaller" at 16 kHz, each with the size `bytesOf(quality)` comes to (null
// until it is known). A file at 16 kHz or below has nothing to gain from
// Smaller, so only Full is offered.

// The quality a dialog starts on, until one is chosen: Full, unless it is over
// the server's limit and Smaller is not.
export const startingQuality = (bytesOf, maxBytes) => {
  const over = (quality) => maxBytes != null && (bytesOf(quality) ?? 0) > maxBytes;
  return over('full') && !over('small') ? 'small' : 'full';
};

const QUALITIES = [
  ['full', (rate) => (rate ? `Full quality (${Math.round(rate / 100) / 10} kHz)` : 'Full quality')],
  ['small', () => `Smaller (${SMALL_RATE / 1000} kHz)`],
];

export function QualityChoice({ value, onChange, fullRate, bytesOf, maxBytes, disabled }) {
  const name = useId();
  const qualities = fullRate != null && fullRate <= SMALL_RATE ? QUALITIES.slice(0, 1) : QUALITIES;
  return (
    <div role="radiogroup" aria-label="Quality" className="flex flex-col gap-1 text-sm">
      {qualities.map(([quality, label]) => (
        <label key={quality} className="flex cursor-pointer items-center gap-2">
          <input
            type="radio"
            name={name}
            value={quality}
            checked={value === quality}
            disabled={disabled}
            onChange={() => onChange(quality)}
          />
          <span>{label(fullRate)}</span>
          {bytesOf(quality) != null && (
            <span className="text-xs text-muted-foreground">
              · {formatBytes(bytesOf(quality), { against: maxBytes })}
            </span>
          )}
        </label>
      ))}
    </div>
  );
}
