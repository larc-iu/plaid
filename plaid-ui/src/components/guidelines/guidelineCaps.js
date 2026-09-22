import { useEffect, useState } from 'react';

// The ceilings the server puts on a guideline, so the editor can refuse a body
// where it was typed instead of after a round trip that arrives as a raw 400.
//
// They come from the server: `plaid.sql.guideline/max-title-length` and
// `max-body-length` are published on GET /info as `limits.guidelineTitleLength`
// and `limits.guidelineBodyLength`, the way the attachment chunk budget reads
// `userDataValueBytes` (`../assistant/attachments.js`). The numbers below are
// the fallback for a server too old to publish them, or one that will not
// answer: the write is refused either way, just later and less kindly.
//
// Both sides count the same units (Clojure's `count` over a String and JS's
// `.length` are both UTF-16 code units), so the two numbers are comparable.
const TITLE_MAX_FALLBACK = 100;
const BODY_MAX_FALLBACK = 20000;

const positive = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback);

/**
 * The guideline caps this server enforces, read once per client. The fallback
 * is in place from the first render, so nothing waits on /info to draw.
 */
export const useGuidelineCaps = (client) => {
  const [caps, setCaps] = useState({
    titleMax: TITLE_MAX_FALLBACK,
    bodyMax: BODY_MAX_FALLBACK,
  });

  useEffect(() => {
    if (!client) return undefined;
    let alive = true;
    // The client caches /info, so every screen asking costs one request.
    Promise.resolve()
      .then(() => client.server.limits())
      .then((limits) => {
        if (!alive || !limits) return;
        setCaps({
          titleMax: positive(limits.guidelineTitleLength, TITLE_MAX_FALLBACK),
          bodyMax: positive(limits.guidelineBodyLength, BODY_MAX_FALLBACK),
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [client]);

  return caps;
};
