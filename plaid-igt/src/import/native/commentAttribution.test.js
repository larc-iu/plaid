import { describe, it, expect } from 'vitest';
import { attributedBody, formatAuthor, formatDate, MAX_BODY_LENGTH } from './commentAttribution.js';

const ADA = { id: 'honestlyada@aol.com', name: 'Ada Lovelace' };

describe('formatAuthor', () => {
  it('writes the display name with the id, which is the email', () => {
    expect(formatAuthor(ADA)).toBe('Ada Lovelace <honestlyada@aol.com>');
  });

  it('falls back to the bare id when the archive recorded no display name', () => {
    expect(formatAuthor({ id: 'x@y.com', name: null })).toBe('x@y.com');
  });

  it('does not repeat the id when it is also the name', () => {
    expect(formatAuthor({ id: 'x@y.com', name: 'x@y.com' })).toBe('x@y.com');
  });

  it('says so rather than rendering "null" when there is no author at all', () => {
    expect(formatAuthor(undefined)).toBe('an unknown author');
  });
});

describe('formatDate', () => {
  it('keeps the date and drops the clock time', () => {
    expect(formatDate('2026-08-14T09:31:07.221Z')).toBe('2026-08-14');
  });

  it('passes through anything that is not plainly ISO rather than guessing', () => {
    expect(formatDate('last Tuesday')).toBe('last Tuesday');
    expect(formatDate(null)).toBe('');
  });
});

describe('attributedBody', () => {
  const comment = (over = {}) => ({
    author: ADA,
    createdAt: '2026-08-14T09:31:07Z',
    body: 'Is this really a dative?',
    ...over,
  });

  it('puts the original attribution in a blockquote above the untouched body', () => {
    const { body, attributed } = attributedBody(comment());
    expect(attributed).toBe(true);
    expect(body).toBe(
      '> Imported from an archive. Originally posted by Ada Lovelace <honestlyada@aol.com> on 2026-08-14.\n\n' +
        'Is this really a dative?',
    );
  });

  it('omits the date clause when the archive has no timestamp', () => {
    const { body } = attributedBody(comment({ createdAt: null }));
    expect(body).toContain('Originally posted by Ada Lovelace <honestlyada@aol.com>.');
    expect(body).not.toContain(' on ');
  });

  it('does not stack notes when an already-imported project is imported again', () => {
    const once = attributedBody(comment()).body;
    // Second hop: the archive now records the FIRST importer as the author.
    const twice = attributedBody(comment({ body: once, author: { id: 'bob@x.com' } })).body;
    expect(twice.match(/Imported from an archive/g)).toHaveLength(1);
    expect(twice).toContain('posted by bob@x.com on 2026-08-14.');
    expect(twice).toContain('Is this really a dative?');
  });

  it('leaves a quotation of a note alone when it is not the leading block', () => {
    const quoted = 'See below.\n\n> Imported from an archive. Originally posted by someone.';
    expect(attributedBody(comment({ body: quoted })).body).toContain(quoted);
  });

  it('drops the note rather than truncating words that would breach the ceiling', () => {
    const long = 'x'.repeat(MAX_BODY_LENGTH - 10);
    const { body, attributed } = attributedBody(comment({ body: long }));
    expect(attributed).toBe(false);
    expect(body).toBe(long);
    expect(body.length).toBeLessThanOrEqual(MAX_BODY_LENGTH);
  });

  it('still posts something when the archived body is empty', () => {
    // A blank body would be a 400 from the server, so the note stands alone.
    const { body } = attributedBody(comment({ body: '' }));
    expect(body.trim()).not.toBe('');
    expect(body).toContain('Ada Lovelace');
  });
});
