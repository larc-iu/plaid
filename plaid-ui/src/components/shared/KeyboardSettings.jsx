import { Fragment, useState, useSyncExternalStore } from 'react';
import { useAuth } from '../../contexts/useAuth.js';
import { chordCaps, chordText, chordsOf, isModifierKeydown } from '../../lib/chords.js';
import { saveUserKeymap } from '../../lib/userKeymap.js';
import { notifyError } from '../../lib/notify.js';
import { humanizeError } from '../../lib/errors.js';
import { Button } from '../ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '../ui/card';

// A person's own keyboard shortcuts: every rebindable action of an app's
// keymap, by group, with the chord it answers to. "Change" listens for the next
// chord pressed and binds it, unless the browser owns it, it would type into a
// text box, or something that can hear it already has it. Each change is saved
// to the account as it is made (lib/userKeymap.js), so there is no draft to
// lose and no Save to forget.
//
// The keymap is the app's live one: a change takes effect under the hand that
// made it, and the legends print it the next time they open.

const Caps = ({ chord }) =>
  chordCaps(chord).map((cap, i) => (
    <Fragment key={i}>
      {i > 0 && <span className="text-muted-foreground">+</span>}
      <kbd className="rounded border bg-background px-1.5 py-0.5 font-mono text-[11px]">{cap}</kbd>
    </Fragment>
  ));

const problemText = (found, chord) => {
  const pressed = chordText(chord, { words: true });
  if (found.problem === 'reserved') return `The browser uses ${pressed}.`;
  if (found.problem === 'types') {
    const [mod] = chordCaps('Mod+x', { words: true });
    const [alt] = chordCaps('Alt+x', { words: true });
    return `${pressed} types a character. Add ${mod} or ${alt}.`;
  }
  if (found.problem === 'conflict') {
    return found.with.fixed
      ? `${pressed} has a fixed meaning here.`
      : `${pressed} is “${found.with.label}”.`;
  }
  return `${pressed} cannot be used.`;
};

export const KeyboardSettings = ({ keymap, groups }) => {
  const { user, client } = useAuth();
  const overrides = useSyncExternalStore(keymap.subscribe, keymap.overrides);
  // The action listening for its new chord, and why the last one was refused.
  const [recording, setRecording] = useState(null);
  const [problem, setProblem] = useState(null);
  const [saving, setSaving] = useState(false);

  const apply = async (next) => {
    const before = keymap.overrides();
    keymap.setOverrides(next);
    setSaving(true);
    try {
      await saveUserKeymap(client, user.id, keymap.overrides());
    } catch (e) {
      keymap.setOverrides(before);
      notifyError(humanizeError(e), 'Shortcut not saved');
    } finally {
      setSaving(false);
    }
  };

  const stop = () => {
    setRecording(null);
    setProblem(null);
  };

  const onRecordKey = (id) => (e) => {
    // Tab leaves, as it does everywhere, and Escape backs out.
    if (e.key === 'Tab') return stop();
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') return stop();
    const [chord] = chordsOf(e.nativeEvent);
    if (!chord) {
      // A modifier on its way down is not an answer yet. Anything else that
      // spells no chord (a character typed through AltGr, an IME's key) is.
      if (!isModifierKeydown(e.nativeEvent)) setProblem('That key cannot be used.');
      return undefined;
    }
    const found = keymap.check(id, chord);
    if (found) return setProblem(problemText(found, chord));
    stop();
    return apply(keymap.withBinding(id, chord));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Keyboard shortcuts</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {groups.map((group) => (
          <section key={group.id} aria-label={group.label}>
            <h3 className="mb-1 text-sm font-medium">{group.label}</h3>
            <ul className="divide-y rounded-md border">
              {keymap.actions
                .filter((a) => !a.fixed && a.group === group.id)
                .map((action) => {
                  const isRecording = recording === action.id;
                  return (
                    <li key={action.id} className="flex flex-col gap-1 px-3 py-2">
                      <div className="flex items-center gap-3">
                        <span className="min-w-0 flex-1 text-sm">{action.label}</span>
                        {isRecording ? (
                          <button
                            type="button"
                            autoFocus
                            className="rounded border border-primary px-2 py-0.5 text-xs text-primary outline-none ring-2 ring-primary/30"
                            aria-label={`Press the new shortcut for ${action.label}`}
                            onKeyDown={onRecordKey(action.id)}
                            onBlur={stop}
                          >
                            Press the new shortcut
                          </button>
                        ) : (
                          <span className="flex shrink-0 items-center gap-1">
                            {keymap.chords(action.id).map((chord, i) => (
                              <Fragment key={chord}>
                                {i > 0 && (
                                  <span className="px-1 text-xs text-muted-foreground">or</span>
                                )}
                                <Caps chord={chord} />
                              </Fragment>
                            ))}
                          </span>
                        )}
                        <span className="flex w-32 shrink-0 justify-end gap-1">
                          {isRecording ? (
                            <Button variant="ghost" size="sm" onMouseDown={stop}>
                              Cancel
                            </Button>
                          ) : (
                            <>
                              {overrides[action.id] && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={saving}
                                  aria-label={`Reset the shortcut for ${action.label}`}
                                  onClick={() => apply(keymap.withBinding(action.id, null))}
                                >
                                  Reset
                                </Button>
                              )}
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={saving}
                                aria-label={`Change the shortcut for ${action.label}`}
                                onClick={() => {
                                  setProblem(null);
                                  setRecording(action.id);
                                }}
                              >
                                Change
                              </Button>
                            </>
                          )}
                        </span>
                      </div>
                      {isRecording && (
                        <p className="text-xs text-muted-foreground" role="status">
                          {problem ?? 'Esc cancels.'}
                        </p>
                      )}
                    </li>
                  );
                })}
            </ul>
          </section>
        ))}
        {Object.keys(overrides).length > 0 && (
          <div>
            <Button variant="outline" size="sm" disabled={saving} onClick={() => apply({})}>
              Reset all
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
