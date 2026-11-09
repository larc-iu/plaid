// Hearing some channels of a recording and not others. The media element
// plays every channel as the browser lays them out (a third channel goes to
// a centre speaker, a fourth nowhere), so a recording with a channel per
// speaker is routed through Web Audio instead: the element's sound is split
// into channels, each gets a gain, and every gain goes to both ears. Mute and
// Solo set the gains. They are a view setting, kept nowhere.
//
// `channelGains` is the arithmetic, on its own so it runs in node. The mixer
// below is the browser graph, built once per element: an element can be made
// a source only once, and once it is, its own output is silent.

/**
 * The gain of each of `count` channels: a soloed set is all that plays when
 * there is one, else everything not muted. `muted` and `solo` are sets of
 * channel indexes (anything with `has`).
 */
export function channelGains(count, muted, solo) {
  const gains = [];
  for (let i = 0; i < count; i += 1) {
    gains.push(solo?.size ? (solo.has(i) ? 1 : 0) : muted?.has(i) ? 0 : 1);
  }
  return gains;
}

const AudioCtx = () =>
  typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);

/**
 * The graph for one media element. `attach(element, count)` builds it (or
 * rebuilds the per-channel part for another count), `setGains(gains)` applies
 * the channels' gains, `dispose()` closes the context.
 */
export function createChannelMixer() {
  let context = null;
  let source = null;
  let element = null;
  let splitter = null;
  let gains = [];
  let merger = null;
  let wanted = [];
  let onPlay = null;

  const apply = () => {
    gains.forEach((gain, i) => {
      gain.gain.value = wanted[i] ?? 1;
    });
  };

  const rebuild = (count) => {
    splitter?.disconnect();
    merger?.disconnect();
    for (const gain of gains) gain.disconnect();
    splitter = context.createChannelSplitter(count);
    merger = context.createChannelMerger(2);
    gains = [];
    source.disconnect();
    source.connect(splitter);
    for (let i = 0; i < count; i += 1) {
      const gain = context.createGain();
      splitter.connect(gain, i);
      // Both ears: a channel is a speaker, not a side of the room.
      gain.connect(merger, 0, 0);
      gain.connect(merger, 0, 1);
      gains.push(gain);
    }
    merger.connect(context.destination);
    apply();
  };

  return {
    attach(el, count) {
      const Ctx = AudioCtx();
      if (!Ctx || !el || !(count > 0)) return false;
      // Another element (the player remounted): the old graph goes.
      if (element && element !== el) this.dispose();
      if (!context) {
        context = new Ctx();
        source = context.createMediaElementSource(el);
        element = el;
        // A context made outside a gesture starts suspended, and playback is
        // always a gesture.
        onPlay = () => {
          if (context.state === 'suspended') context.resume().catch(() => {});
        };
        el.addEventListener('play', onPlay);
        if (!el.paused) onPlay();
      }
      if (gains.length !== count) rebuild(count);
      return true;
    },
    setGains(next) {
      wanted = next || [];
      apply();
    },
    get attached() {
      return !!context;
    },
    get channelCount() {
      return gains.length;
    },
    dispose() {
      if (element && onPlay) element.removeEventListener('play', onPlay);
      context?.close().catch(() => {});
      context = null;
      source = null;
      element = null;
      splitter = null;
      merger = null;
      gains = [];
    },
  };
}
