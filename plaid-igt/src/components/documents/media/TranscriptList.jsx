import React, {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Pause, Play, Trash2 } from 'lucide-react';
import { cpSlice, isMachine } from '@larc-iu/plaid-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';
import { useIgtDocument } from '../../../domain/useIgtDocument.js';
import { formatTime } from './formatTime.js';
import { getStickySpeaker, setStickySpeaker } from './stickySpeaker.js';

// The transcript: every time-aligned segment as a row you can type into, in
// time order, with the recording following your focus. This is the pass a
// linguist makes by ear. The timeline above is for cutting and trimming, and
// the transcription-service card below lets a model take the first pass.
//
// Rows are keyed by token id. Editing a segment's text recreates its token
// (delete + insert cascade, see mutations/alignment.js), so a row that was just
// edited unmounts and its successor mounts. Focus therefore always MOVES on a
// commit (to the next row, or to the new-segment row) and never tries to stay.
// The document single-flights its writes, so a commit waits for any write in
// flight before issuing its own instead of being dropped.

const SPEAKER_LIST_ID = 'transcript-speaker-options';
const timeBeginOf = (t) => t.metadata?.timeBegin ?? 0;
const timeEndOf = (t) => t.metadata?.timeEnd ?? timeBeginOf(t);
const byTime = (a, b) => timeBeginOf(a) - timeBeginOf(b);

// Resolves once the document has no write in flight.
const whenIdle = (doc) =>
  new Promise((resolve) => {
    if (!doc.isSaving) return resolve();
    const unsubscribe = doc.subscribe(() => {
      if (!doc.isSaving) {
        unsubscribe();
        resolve();
      }
    });
  });

// A textarea that grows with its content, so a long utterance is never a
// one-line slot you scroll inside.
const autoGrow = (el) => {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
};

const SegmentRow = memo(function SegmentRow({
  token,
  index,
  text,
  active,
  playing,
  readOnly,
  onFocusRow,
  onCommit,
  onAdvance,
  onDelete,
  onPlayToggle,
  registerText,
}) {
  const storedSpeaker = token.metadata?.speaker || '';
  // The edit state lives in refs mirrored into state: the keydown that commits
  // and the blur that follows it (focus moves on Enter) run before React has
  // re-rendered, so a guard read from a closure would still see the old edit
  // and write it twice. The state copies only drive rendering.
  const [draft, setDraftState] = useState(text);
  const [speaker, setSpeakerState] = useState(storedSpeaker);
  const [dirty, setDirtyState] = useState(false);
  const draftRef = useRef(text);
  const speakerRef = useRef(storedSpeaker);
  const dirtyRef = useRef(false);
  const textRef = useRef(null);
  const inFlight = useRef(null);

  const setDraft = (v) => {
    draftRef.current = v;
    setDraftState(v);
  };
  const setSpeaker = (v) => {
    speakerRef.current = v;
    setSpeakerState(v);
  };
  const setDirty = (v) => {
    dirtyRef.current = v;
    setDirtyState(v);
  };

  // A row that is not being edited always shows what is stored.
  useEffect(() => {
    if (!dirty) {
      setDraft(text);
      setSpeaker(storedSpeaker);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, storedSpeaker, dirty]);

  useLayoutEffect(() => autoGrow(textRef.current), [draft]);

  const revert = () => {
    setDraft(text);
    setSpeaker(storedSpeaker);
    setDirty(false);
  };

  // One commit at a time per row, and never the same edit twice.
  const commit = () => {
    if (inFlight.current) return inFlight.current;
    const run = async () => {
      if (!dirtyRef.current) return true;
      const nextText = draftRef.current.trim();
      const nextSpeaker = speakerRef.current.trim();
      if (!nextText) {
        // An emptied row is put back; removing a segment is the explicit Delete.
        revert();
        return true;
      }
      if (nextText === text && nextSpeaker === storedSpeaker) {
        setDirty(false);
        return true;
      }
      const ok = await onCommit(token.id, { text: nextText, speaker: nextSpeaker });
      // On failure the typing stays in the row; the document has already toasted why.
      if (ok) setDirty(false);
      return ok;
    };
    inFlight.current = run().finally(() => {
      inFlight.current = null;
    });
    return inFlight.current;
  };

  const onTextKeyDown = async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const timeBegin = timeBeginOf(token);
      if (await commit()) onAdvance(timeBegin);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      revert();
    } else if (e.key === ' ' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onPlayToggle(token);
    }
  };

  const onSpeakerKeyDown = async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (await commit()) textRef.current?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      revert();
    }
  };

  const machine = isMachine(token.metadata);

  return (
    <div
      data-segment-id={token.id}
      className={cn(
        'grid grid-cols-[auto_minmax(6rem,8rem)_1fr_auto] items-start gap-2 rounded-md border px-2 py-1.5',
        active && 'border-primary/60 bg-primary/5',
      )}
    >
      <div className="flex flex-col pt-1 font-mono text-[11px] leading-4 tabular-nums text-muted-foreground">
        <span>{formatTime(timeBeginOf(token))}</span>
        <span>{formatTime(timeEndOf(token))}</span>
        {machine && (
          <span className="mt-0.5 text-[10px] uppercase tracking-wide text-violet-600">
            machine
          </span>
        )}
      </div>

      {readOnly ? (
        <span className="pt-1.5 text-xs text-muted-foreground">{storedSpeaker}</span>
      ) : (
        <Input
          value={speaker}
          list={SPEAKER_LIST_ID}
          placeholder="Speaker"
          aria-label={`Segment ${index + 1} speaker`}
          autoComplete="off"
          className="h-8 text-xs"
          onChange={(e) => {
            setSpeaker(e.target.value);
            setDirty(true);
          }}
          onKeyDown={onSpeakerKeyDown}
          onBlur={commit}
        />
      )}

      {readOnly ? (
        <p className="whitespace-pre-wrap py-1.5 text-sm">{text}</p>
      ) : (
        <Textarea
          ref={(el) => {
            textRef.current = el;
            registerText(token.id, el);
            autoGrow(el);
          }}
          value={draft}
          rows={1}
          spellCheck={false}
          aria-label={`Segment ${index + 1} text`}
          className="min-h-8 resize-none py-1.5 text-sm"
          onChange={(e) => {
            setDraft(e.target.value);
            setDirty(true);
          }}
          onFocus={() => onFocusRow(token)}
          onKeyDown={onTextKeyDown}
          onBlur={commit}
        />
      )}

      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          aria-label={playing ? 'Pause segment' : 'Play segment'}
          onClick={() => onPlayToggle(token)}
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </Button>
        {!readOnly && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 hover:text-destructive"
            aria-label="Delete segment"
            onClick={() => onDelete(token.id)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
});

// The row that adds a segment by ear: it runs from the end of the last
// segment to wherever the playhead is when Enter is pressed. Adding a segment
// earlier in the recording is the timeline's job (drag over the stretch).
const NewSegmentRow = memo(function NewSegmentRow({
  prevEnd,
  currentTime,
  onCreate,
  onToggle,
  textRef,
}) {
  const [draft, setDraft] = useState('');
  const [speaker, setSpeaker] = useState(getStickySpeaker);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  const ready = currentTime > prevEnd + 0.01;
  const canCreate = ready && draft.trim().length > 0;

  useLayoutEffect(() => autoGrow(ref.current), [draft]);

  const submit = async () => {
    if (!canCreate || busy) return;
    setBusy(true);
    try {
      const ok = await onCreate({
        text: draft.trim(),
        timeBegin: prevEnd,
        timeEnd: currentTime,
        speaker: speaker.trim(),
      });
      if (ok) {
        setDraft('');
        setStickySpeaker(speaker);
      }
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDraft('');
    } else if (e.key === ' ' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onToggle();
    }
  };

  return (
    <div className="grid grid-cols-[auto_minmax(6rem,8rem)_1fr_auto] items-start gap-2 rounded-md border border-dashed px-2 py-1.5">
      <div className="flex flex-col pt-1 font-mono text-[11px] leading-4 tabular-nums text-muted-foreground">
        <span>{formatTime(prevEnd)}</span>
        <span>{ready ? formatTime(currentTime) : '…'}</span>
      </div>
      <Input
        value={speaker}
        list={SPEAKER_LIST_ID}
        placeholder="Speaker"
        aria-label="New segment speaker"
        autoComplete="off"
        className="h-8 text-xs"
        onChange={(e) => setSpeaker(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="flex flex-col gap-1">
        <Textarea
          ref={(el) => {
            ref.current = el;
            if (textRef) textRef.current = el;
            autoGrow(el);
          }}
          value={draft}
          rows={1}
          spellCheck={false}
          placeholder="New segment"
          aria-label="New segment text"
          className="min-h-8 resize-none py-1.5 text-sm"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <p className="text-xs text-muted-foreground">
          {ready
            ? `${formatTime(prevEnd)} to ${formatTime(currentTime)} (playback). Enter to save.`
            : `Playback must be past ${formatTime(prevEnd)}. For earlier segments, drag on the timeline.`}
        </p>
      </div>
      <div className="h-8 w-8" />
    </div>
  );
});

export function TranscriptList({ mediaOps, readOnly = false }) {
  const { doc } = useDocumentCtx();
  useIgtDocument(doc);

  // `mediaOps` is a fresh object every render; callbacks read it through a ref
  // so the memoized rows keep their identity while the playhead moves.
  const opsRef = useRef(mediaOps);
  opsRef.current = mediaOps;

  const containerRef = useRef(null);
  const textRefs = useRef(new Map());
  const newTextRef = useRef(null);

  const segments = useMemo(() => [...doc.alignmentTokens].sort(byTime), [doc.alignmentTokens]);
  const body = doc.body || '';
  const { currentTime = 0, isPlaying, playingSelection, selection } = mediaOps;

  const activeId = useMemo(() => {
    const hit = segments.find((t) => timeBeginOf(t) <= currentTime && currentTime < timeEndOf(t));
    return hit?.id ?? null;
  }, [segments, currentTime]);

  const playingId = useMemo(() => {
    if (!isPlaying || !playingSelection) return null;
    const hit = segments.find(
      (t) => timeBeginOf(t) === playingSelection.start && timeEndOf(t) === playingSelection.end,
    );
    return hit?.id ?? null;
  }, [segments, isPlaying, playingSelection]);

  const registerText = useCallback((id, el) => {
    if (el) textRefs.current.set(id, el);
    else textRefs.current.delete(id);
  }, []);

  const handleFocusRow = useCallback((token) => {
    const ops = opsRef.current;
    const range = { start: timeBeginOf(token), end: timeEndOf(token) };
    ops.setPopoverOpened(false);
    ops.setSelection(range);
    if (ops.autoPlayOnFocus) ops.playRange(range);
    containerRef.current
      ?.querySelector(`[data-segment-id="${token.id}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, []);

  const handlePlayToggle = useCallback((token) => {
    const ops = opsRef.current;
    const range = { start: timeBeginOf(token), end: timeEndOf(token) };
    const isThis =
      ops.playingSelection &&
      ops.playingSelection.start === range.start &&
      ops.playingSelection.end === range.end;
    if (ops.isPlaying && isThis) ops.pausePlayback();
    else ops.playRange(range);
  }, []);

  const handleCommit = useCallback(
    async (id, { text, speaker }) => {
      await whenIdle(doc);
      const token = doc.alignmentTokens.find((t) => t.id === id);
      if (!token) return false;
      const storedText = cpSlice(doc.body || '', token.begin, token.end);
      const storedSpeaker = token.metadata?.speaker || '';
      if (text !== storedText) {
        return doc.editAlignment(id, {
          text,
          timeBegin: timeBeginOf(token),
          timeEnd: timeEndOf(token),
          speaker,
        });
      }
      if (speaker !== storedSpeaker) return doc.updateAlignmentSpeaker(id, speaker);
      return true;
    },
    [doc],
  );

  const handleCreate = useCallback(
    async (args) => {
      await whenIdle(doc);
      return doc.createAlignment(args);
    },
    [doc],
  );

  const handleDelete = useCallback((id) => opsRef.current.handleDeleteAlignment(id), []);

  // After a commit the edited row may be gone (new token id), so the successor
  // is found by time on the document itself, which is always current.
  const handleAdvance = useCallback(
    (timeBegin) => {
      const next = [...doc.alignmentTokens].sort(byTime).find((t) => timeBeginOf(t) > timeBegin);
      const el = next ? textRefs.current.get(next.id) : newTextRef.current;
      el?.focus();
    },
    [doc],
  );

  const handleToggleFree = useCallback(() => opsRef.current.togglePlayback(), []);

  // A segment picked on the timeline scrolls its row into view (without taking
  // focus, since the timeline's popover owns it then).
  useEffect(() => {
    if (!selection) return;
    const match = segments.find(
      (t) => timeBeginOf(t) === selection.start && timeEndOf(t) === selection.end,
    );
    if (!match) return;
    containerRef.current
      ?.querySelector(`[data-segment-id="${match.id}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [selection, segments]);

  const prevEnd = segments.length ? Math.max(...segments.map(timeEndOf)) : 0;

  return (
    <div className="tw rounded-lg border bg-card p-4" ref={containerRef}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium">Transcript</span>
          <span className="text-xs text-muted-foreground">
            {segments.length === 1 ? '1 segment' : `${segments.length} segments`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="transcript-play-on-focus"
            checked={!!mediaOps.autoPlayOnFocus}
            onCheckedChange={(on) => mediaOps.setAutoPlayOnFocus(on)}
          />
          <Label htmlFor="transcript-play-on-focus" className="text-xs font-normal">
            Play segment on entry
          </Label>
        </div>
      </div>

      {!readOnly && (
        <datalist id={SPEAKER_LIST_ID}>
          {doc.knownSpeakers.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}

      {/* The rows scroll inside a bounded box so a long transcript never pushes
          the recording controls, the timeline, or the new-segment row out of
          reach. Focus and timeline picks scroll their row into view. */}
      <div className="flex max-h-[45vh] min-h-[6rem] flex-col gap-1.5 overflow-y-auto pr-1">
        {segments.length === 0 && (
          <p className="py-2 text-sm text-muted-foreground">
            {readOnly
              ? 'No segments.'
              : 'No segments yet. Add one below, drag on the timeline, or run a transcription service.'}
          </p>
        )}
        {segments.map((token, index) => (
          <SegmentRow
            key={token.id}
            token={token}
            index={index}
            text={cpSlice(body, token.begin, token.end)}
            active={token.id === activeId}
            playing={token.id === playingId}
            readOnly={readOnly}
            onFocusRow={handleFocusRow}
            onCommit={handleCommit}
            onAdvance={handleAdvance}
            onDelete={handleDelete}
            onPlayToggle={handlePlayToggle}
            registerText={registerText}
          />
        ))}
      </div>
      {!readOnly && (
        <div className="mt-1.5">
          <NewSegmentRow
            prevEnd={prevEnd}
            currentTime={currentTime}
            onCreate={handleCreate}
            onToggle={handleToggleFree}
            textRef={newTextRef}
          />
        </div>
      )}
    </div>
  );
}
