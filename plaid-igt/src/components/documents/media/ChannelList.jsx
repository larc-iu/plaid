import { useEffect, useState } from 'react';
import { Button } from '@ui/components/ui/button';
import { Input } from '@ui/components/ui/input';
import { cn } from '@ui/lib/utils';
import { channelLabel } from '@/domain/media/channelSpeakers';
import { speakerHue } from '@/domain/speakerHue.js';

// The channels of a multichannel recording, one row each: a swatch in the
// speaker's colour, the speaker (editable, written to the document as
// `channelSpeakers`), Mute and Solo. Mute and Solo are how the recording is
// heard here and now, kept nowhere.

const SPEAKER_LIST_ID = 'channel-speaker-options';

const SpeakerField = ({ value, label, disabled, onCommit }) => {
  const [draft, setDraft] = useState(value);
  // Another tab's write lands in `value`, and a box not being typed in follows it.
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() !== value) onCommit(draft);
  };
  return (
    <Input
      value={draft}
      list={SPEAKER_LIST_ID}
      placeholder="Speaker"
      compose
      autoComplete="off"
      aria-label={`${label} speaker`}
      className="h-8 text-xs"
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setDraft(value);
        }
      }}
    />
  );
};

/**
 * @param count        the recording's channels
 * @param speakers     `channelSpeakers` as stored, or null
 * @param knownSpeakers the project's and document's speaker suggestions
 * @param muted, solo  sets of channel indexes
 * @param onRemove     the channels are not speakers after all (removes the list)
 */
export function ChannelList({
  count,
  speakers,
  knownSpeakers = [],
  muted,
  solo,
  onToggleMute,
  onToggleSolo,
  onSpeakerChange,
  onRemove,
  readOnly = false,
}) {
  if (!(count >= 2)) return null;
  const channels = Array.from({ length: count }, (_, i) => i);
  return (
    <div className="flex flex-col gap-1" data-channel-list="">
      <ul className="flex flex-col gap-1">
        {channels.map((i) => {
          const speaker = speakers?.[i] || '';
          const label = channelLabel(i, speakers);
          const hue = speaker ? speakerHue(speaker, knownSpeakers) : null;
          const isMuted = muted?.has(i) ?? false;
          const isSolo = solo?.has(i) ?? false;
          return (
            <li
              key={i}
              data-channel={i}
              className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2"
            >
              <span
                aria-hidden="true"
                className="h-3 w-3 rounded-sm"
                style={{
                  backgroundColor:
                    hue === null ? 'hsl(var(--primary) / 0.45)' : `hsl(${hue}, 60%, 45%)`,
                }}
              />
              <SpeakerField
                value={speaker}
                label={label}
                disabled={readOnly}
                onCommit={(name) => onSpeakerChange(i, name)}
              />
              <div className="flex items-center gap-1">
                <Button
                  variant={isMuted ? 'secondary' : 'ghost'}
                  size="sm"
                  className={cn('h-8 px-2 text-xs', isMuted && 'text-primary')}
                  aria-pressed={isMuted}
                  aria-label={`Mute ${label}`}
                  onClick={() => onToggleMute(i)}
                >
                  Mute
                </Button>
                <Button
                  variant={isSolo ? 'secondary' : 'ghost'}
                  size="sm"
                  className={cn('h-8 px-2 text-xs', isSolo && 'text-primary')}
                  aria-pressed={isSolo}
                  aria-label={`Solo ${label}`}
                  onClick={() => onToggleSolo(i)}
                >
                  Solo
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      {!readOnly && onRemove && (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={onRemove}
          >
            Remove speakers per channel
          </Button>
        </div>
      )}
      {!readOnly && (
        <datalist id={SPEAKER_LIST_ID}>
          {knownSpeakers.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  );
}
