// The igt job screens' words for what a job reports: its tasks taken
// together, a skipped sentence, a harmonize decision. The words for a job's
// codes (its state, phase, reason, a task, a document's state) are plaid-ui's
// (domain/jobs.js), since every app says them.

// What a job was asked to write, as History names its entries ("Assistant
// job: translations and analyses"), capitalized: "Translations and analyses".
export const tasksText = (tasks = []) => {
  const nouns = [];
  if (tasks.includes('translate')) nouns.push('translations');
  if (tasks.includes('gloss')) {
    nouns.push(tasks.includes('link') ? 'analyses and lexicon links' : 'analyses');
  }
  if (!nouns.length) return '';
  const text =
    nouns.length === 1
      ? nouns[0]
      : nouns[1] === 'analyses'
        ? 'translations and analyses'
        : 'translations, analyses and lexicon links';
  return text[0].toUpperCase() + text.slice(1);
};

// Where a job's page is.
export const jobPath = (projectId, jobId) => `/projects/${projectId}/jobs/${jobId}`;
