import { useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { useConfirm } from './ConfirmProvider.jsx';
import { Button } from '../ui/button.jsx';
import { Textarea } from '../ui/textarea.jsx';
import { SafeMarkdown } from '../ui/markdown.jsx';
import { timeAgo, fullTimestamp } from '../../utils/formatTime.js';
import { isPending } from '../../domain/CommentStore.js';

// One thread: its comments oldest first, and a box to add to it.
//
// This is the REACT rendering of a thread, for the two Comments tabs. plaid-igt
// keeps a lit-html twin (island/CommentThread.js) because that one mounts
// inside the interlinear editor's lit island, where React cannot go. The two
// render the same store and must keep the same rules: who may edit, who may
// delete, what a pending comment looks like, so both read them off the store
// rather than deciding for themselves.

const MAX_BODY = 10000; // matches plaid.sql.comment/max-body-length

const initials = (name) => {
  const parts = String(name || '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
};

const onMetaEnter = (fn) => (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    fn();
  }
};

const metaKeyLabel = () =>
  typeof navigator !== 'undefined' && navigator.platform?.startsWith('Mac') ? '⌘' : 'Ctrl';

const Comment = ({ comment, store, canDeleteAny, onEdit, onRemove }) => {
  const [draft, setDraft] = useState(null); // null = not editing
  const pending = isPending(comment);
  const mine = comment.authorId === store.currentUserId;
  const name = store.authorName(comment.authorId);
  const mayEdit = store.canEdit(comment);
  // The author may always remove their own; a maintainer may remove any. Never
  // offered for a comment the server has not acknowledged yet.
  const mayDelete = !pending && (mayEdit || canDeleteAny);

  // A comment is unaudited by ruling, so there is no history entry and no
  // restore: a mis-click on a colleague's thread is permanent. One more click
  // is the house rule for anything destructive, and the only thing standing
  // between the trash icon and a comment nobody can get back.
  const confirm = useConfirm();
  const askThenRemove = async () => {
    const ok = await confirm({
      title: mine ? 'Delete your comment?' : `Delete ${name}'s comment?`,
      description: 'Comments are not kept in the history, so this cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (ok) onRemove(comment);
  };

  if (draft !== null) {
    const unchanged = !draft.trim() || draft.trim() === comment.body;
    const save = () => {
      if (unchanged) return;
      onEdit(comment, draft.trim());
      setDraft(null);
    };
    return (
      <li className="border-b px-3 py-2 last:border-b-0">
        <Textarea
          rows={3}
          maxLength={MAX_BODY}
          aria-label="Edit your comment"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setDraft(null);
              return;
            }
            onMetaEnter(save)(e);
          }}
        />
        <div className="mt-1.5 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
            Cancel
          </Button>
          <Button size="sm" disabled={unchanged} onClick={save}>
            Save
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li className={`border-b px-3 py-2 last:border-b-0 ${pending ? 'opacity-60' : ''}`}>
      {/* Actions ride the byline rather than sitting under the body: icons on a
          line that already exists cost no extra height. */}
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span
          aria-hidden="true"
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-foreground"
        >
          {initials(name)}
        </span>
        <span className="font-medium text-foreground">
          {name}
          {mine && <span className="font-normal text-muted-foreground"> (you)</span>}
        </span>
        <time dateTime={comment.createdAt} title={fullTimestamp(comment.createdAt)}>
          {pending ? 'sending…' : timeAgo(comment.createdAt)}
        </time>
        {comment.edited && <span title={`Edited ${fullTimestamp(comment.updatedAt)}`}>edited</span>}
        {(mayEdit || mayDelete) && (
          <span className="ml-auto flex items-center gap-0.5">
            {mayEdit && (
              <button
                type="button"
                title="Edit"
                aria-label="Edit this comment"
                className="rounded p-1 hover:bg-muted hover:text-foreground"
                onClick={() => setDraft(comment.body)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
            {mayDelete && (
              <button
                type="button"
                title="Delete"
                aria-label="Delete this comment"
                className="rounded p-1 hover:bg-muted hover:text-destructive"
                onClick={askThenRemove}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </span>
        )}
      </div>
      <div className="mt-1 text-sm">
        <SafeMarkdown>{comment.body}</SafeMarkdown>
      </div>
    </li>
  );
};

export const CommentThread = ({
  store,
  comments = [],
  canWrite = false,
  canDeleteAny = false,
  entityType,
  entityId,
  anchorLabel = null,
  autoFocusComposer = false,
}) => {
  const [composer, setComposer] = useState('');

  const submit = () => {
    const body = composer.trim();
    if (!body) return;
    setComposer('');
    // The caption is posted WITH the comment, because a comment outlives its
    // anchor: when the thing it was about is merged or retyped away, this is
    // what the thread has left to show.
    store.post(entityType, entityId, body, anchorLabel);
  };

  return (
    <div>
      {comments.length > 0 ? (
        <ul>
          {comments.map((comment) => (
            <Comment
              key={comment.id}
              comment={comment}
              store={store}
              canDeleteAny={canDeleteAny}
              onEdit={(c, body) => store.edit(c.id, body)}
              onRemove={(c) => store.remove(c.id)}
            />
          ))}
        </ul>
      ) : (
        <p className="px-3 py-2 text-sm text-muted-foreground">
          {canWrite ? 'No comments yet.' : 'No comments.'}
        </p>
      )}
      {canWrite && (
        <div className="border-t bg-muted/20 px-3 py-2">
          <Textarea
            rows={2}
            maxLength={MAX_BODY}
            placeholder="Add a comment…"
            aria-label="Add a comment"
            autoFocus={autoFocusComposer}
            value={composer}
            onChange={(e) => setComposer(e.target.value)}
            onKeyDown={onMetaEnter(submit)}
          />
          <div className="mt-1.5 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Markdown · {metaKeyLabel()}+Enter</span>
            <Button size="sm" disabled={!composer.trim()} onClick={submit}>
              Comment
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
