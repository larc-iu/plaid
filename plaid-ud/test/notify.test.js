// What an error toast actually says.
//
// Every one of these used to show whatever the client threw, which for a
// failed request is "HTTP 400 Bad Request at http://host/api/v1/…": an
// internal URL and a status code, on screen, for a linguist. The wording now
// comes from the shared package's `humanizeError`, and it is applied here
// rather than at each of the fifty call sites, so no call site can leak.
//
// sonner keeps its queue in a module-level store whether or not a Toaster is
// mounted, and each notify returns the id of the toast it made, which is what
// lets this read the result back under `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toast } from 'sonner';

import { notifyError, notifyWarning, notifySuccess } from '../src/utils/notify.js';

const shown = (id) => toast.getToasts().find((t) => t.id === id);

test('an error toast shows neither the status line nor the request URL', () => {
  const id = notifyError('HTTP 400 Bad Request at http://localhost:8085/api/v1/projects/abc');
  const t = shown(id);
  assert.equal(t.title, 'Error');
  assert.equal(t.description, 'Bad Request');
});

test('an error toast says what a status means', () => {
  const t = shown(notifyError('HTTP 423 Locked at http://localhost:8085/api/v1/documents/abc'));
  assert.match(t.description, /being edited right now/);
  assert.doesNotMatch(t.description, /http/i);
});

test('an error toast leaves an ordinary message alone', () => {
  const t = shown(notifyError('Failed to load project data'));
  assert.equal(t.description, 'Failed to load project data');
});

test('an error toast keeps the title it was given', () => {
  const t = shown(notifyError('Could not read the project.', 'Scan failed'));
  assert.equal(t.title, 'Scan failed');
  assert.equal(t.description, 'Could not read the project.');
});

test('a warning is titled Warning, the word the other apps use', () => {
  const t = shown(notifyWarning('Your last edit could not be loaded.'));
  assert.equal(t.title, 'Warning');
});

test('a success toast with no title is the message itself', () => {
  const t = shown(notifySuccess('Exported 3 documents.'));
  assert.equal(t.title, 'Exported 3 documents.');
  assert.equal(t.description, undefined);
});
