// The signal that a turn ended while the page was hidden: a system
// notification when the browser allows one, a short chime, and a mark at the
// front of the tab's title until the page is seen again. Nothing happens while
// the page is visible. No React in here (jobs.js calls it).
//
// Browsers let a page ask for notifications and start audio only from
// something the person did, so `primeTurnSignals` is called from the click (or
// key) that sends a message: it asks for permission the first time, and wakes
// the audio the chime will play on.

export const TITLE_MARK = '● ';

let audio = null;
let watching = false;

const AudioCtx = () => globalThis.AudioContext || globalThis.webkitAudioContext || null;

export const primeTurnSignals = () => {
  try {
    const N = globalThis.Notification;
    if (N && N.permission === 'default') {
      // Older Safari answers through a callback and returns nothing.
      N.requestPermission()?.catch?.(() => {});
    }
  } catch {
    // No notifications here: the chime and the title mark still come.
  }
  try {
    const Ctx = AudioCtx();
    if (!Ctx) return;
    audio ??= new Ctx();
    if (audio.state === 'suspended') audio.resume()?.catch?.(() => {});
  } catch {
    audio = null;
  }
};

// One soft two-note chime, about half a second, made here rather than loaded.
const chime = () => {
  try {
    const Ctx = AudioCtx();
    if (!Ctx) return;
    audio ??= new Ctx();
    const t = audio.currentTime;
    [
      [880, 0],
      [1318.5, 0.12],
    ].forEach(([hz, at]) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = hz;
      gain.gain.setValueAtTime(0, t + at);
      gain.gain.linearRampToValueAtTime(0.08, t + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.45);
      osc.connect(gain);
      gain.connect(audio.destination);
      osc.start(t + at);
      osc.stop(t + at + 0.5);
    });
  } catch {
    // No audio here.
  }
};

const unmark = () => {
  if (document.hidden) return;
  if (document.title.startsWith(TITLE_MARK)) {
    document.title = document.title.slice(TITLE_MARK.length);
  }
};

const markTitle = () => {
  if (!document.title.startsWith(TITLE_MARK)) document.title = TITLE_MARK + document.title;
  if (!watching) {
    watching = true;
    document.addEventListener('visibilitychange', unmark);
  }
};

const notify = (title, body, tag, onOpen) => {
  const N = globalThis.Notification;
  if (!N || N.permission !== 'granted') return;
  try {
    const n = new N(title, { body, tag });
    n.onclick = () => {
      window.focus();
      n.close();
      onOpen?.();
    };
  } catch {
    // Some browsers (Chrome on Android) take notifications only from a
    // service worker.
  }
};

// Signal that a turn ended, when the page is hidden. `title` names the
// conversation, `body` is what happened ("Finished", "Failed", "Stopped"),
// `tag` the conversation's id, and `onOpen` shows the conversation when the
// notification is clicked. Answers whether it signalled.
export const signalTurnEnded = ({ title, body, tag, onOpen }) => {
  if (typeof document === 'undefined' || !document.hidden) return false;
  notify(title || 'Assistant', body, tag, onOpen);
  chime();
  markTitle();
  return true;
};

// How a turn this page sent ended, as the notification says it, or null when
// it says nothing: one the person stopped, one still running that the page
// only lost contact with, and one turned down before it began.
export const turnEnding = (j) => {
  if (j.kind !== 'turn' || j.stopping || j.declined || j.gone) return null;
  if (j.error) return j.error.pending ? null : 'Failed';
  if (j.outcome?.kind === 'turn') return 'Finished';
  if (j.outcome?.kind === 'stopped') return 'Stopped';
  return null;
};
