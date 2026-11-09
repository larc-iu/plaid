import { Label } from '@ui/components/ui/label';

// The channels of a recording with a speaker on each, one box per channel,
// all on to begin with: what the speech detector listens to and what the
// transcriber is sent. Shared by the two run dialogs so they list the same
// thing the same way. Nothing is rendered for a recording whose channels are
// not speakers (no channelSpeakers), and the run is then the whole recording.

export function ChannelChecklist({ channels, disabled = false }) {
  if (!channels.list.length) return null;
  return (
    <div className="flex flex-col gap-2" data-channel-checklist="">
      <Label className="text-xs">Channels</Label>
      <ul className="flex flex-col gap-1">
        {channels.list.map((c) => (
          <li key={c.channel}>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={channels.on.has(c.channel)}
                disabled={disabled}
                onChange={() => channels.toggle(c.channel)}
              />
              <span>{c.label}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
