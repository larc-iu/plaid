import { useEffect, useRef } from 'react';

// A transcript box that saves when focus leaves it (a row's text or speaker, a
// proposal, a time box), and what becomes of what is typed in it when the page
// goes instead. It is the Analyze grid's cell rule:
//
//  - a tab or a link click saves it through the blur the click causes, so it
//    is not a draft for useUnsavedDraft to ask about;
//  - the transcript going away with focus still in it (the browser's Back)
//    sends no blur React hears, since React ignores events while it removes
//    the box, so it is saved here as it goes;
//  - a reload cannot wait for a save, so it asks first.
//
// `pending()` says whether there is anything to save, `save()` saves it. Both
// are read when needed, so new closures each render are fine.
export const useSavedOnLeave = (pending, save) => {
  const latest = useRef({ pending, save });
  latest.current = { pending, save };
  useEffect(() => {
    const onBeforeUnload = (e) => {
      if (!latest.current.pending()) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (latest.current.pending()) latest.current.save();
    };
  }, []);
};
