import { Switch } from '@ui/components/ui/switch';
import { Label } from '@ui/components/ui/label';

// Whether a vocabulary is a suggestion or a rule.
//
// A switch rather than two radio buttons, because there are exactly two states
// and one of them is the default. The label says what the CLOSED state does,
// since that is the state a maintainer is deciding to turn on.
export const VocabModeSwitch = ({ id, closed, onChange, noun }) => (
  <div className="flex items-center gap-2">
    <Switch id={id} checked={closed} onCheckedChange={onChange} />
    <Label htmlFor={id} className="cursor-pointer text-sm font-normal text-muted-foreground">
      Refuse {noun} outside this list
    </Label>
  </div>
);
