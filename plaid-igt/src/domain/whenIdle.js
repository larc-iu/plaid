// Resolves once the document has no write in flight. `_withSaving` refuses a
// mutation while another is saving (single flight), so a caller that must not
// lose its edit waits here first instead of being dropped.
export const whenIdle = (doc) =>
  new Promise((resolve) => {
    if (!doc.isSaving) return resolve();
    const unsubscribe = doc.subscribe(() => {
      if (!doc.isSaving) {
        unsubscribe();
        resolve();
      }
    });
  });
