import { fieldKey } from '@/domain/fieldNames';
import { storedIgnoredTokens } from '@/domain/igtConfig';

// What one save changes: the table after the user's edit (`fields`,
// `ignoredTokens`) against the table before it (`previous`).
export const fieldChange = ({ fields, ignoredTokens, previous }) => {
  const before = new Map(previous.fields.map((f) => [fieldKey(f), f]));
  const after = new Set(fields.map(fieldKey));
  const was = (f) => before.get(fieldKey(f));
  return {
    added: fields.filter((f) => !was(f)),
    removed: [...before.values()].filter((f) => !after.has(fieldKey(f))),
    tagset: fields.filter((f) => !was(f) || (was(f).tagset ?? null) !== (f.tagset ?? null)),
    lang: fields.filter((f) => !was(f) || (was(f).lang || null) !== (f.lang || null)),
    ignoredTokens:
      JSON.stringify(storedIgnoredTokens(previous.ignoredTokens)) !==
      JSON.stringify(storedIgnoredTokens(ignoredTokens)),
  };
};
