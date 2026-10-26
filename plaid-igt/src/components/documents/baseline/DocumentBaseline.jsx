import { useEffect, useRef, useState } from 'react';
import { cpSlice, utf16ToCp } from '@larc-iu/plaid-client';
import { Info, Pencil, Save, X } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Label } from '@ui/components/ui/label';
import { Notice } from '@ui/components/shared/Notice.jsx';
import { Textarea } from '@ui/components/ui/textarea';
import { NOT_SET_UP } from '@ui/domain/setupGuard.js';
import { useBaselineOperations } from './useBaselineOperations.js';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';
import { TYPE } from '@ui/lib/typeScale.js';
import { analyzeFocus, baselineFocus, openTab, sentenceNear } from '../hooks/focusHandoff.js';
import './DocumentBaseline.css';

const toUtf16 = (text, at) => cpSlice(text, 0, at).length;

// Coming from the Analyze tab: the sentence the grid was on (focusHandoff.js
// baselineFocus), or the one nearest where it stood, as UTF-16 offsets into
// the body for the screen. Null when there is nothing to land on.
function landingFor(doc) {
  let req = null;
  try {
    req = openTab(baselineFocus);
  } catch {
    /* noop */
  }
  if (!req || req.docId !== doc.id) return null;
  const sentences = doc.sentences || [];
  const s = sentences.find((x) => x.id === req.sentenceId) || sentenceNear(sentences, req.at);
  if (!s) return null;
  const body = doc.body || '';
  return { at: s.begin, from: toUtf16(body, s.begin), to: toUtf16(body, s.end) };
}

export function DocumentBaseline() {
  const { doc, readOnly } = useDocumentCtx();
  const ops = useBaselineOperations();

  // The textarea is controlled by the hook's `editedText` alone. It used to
  // carry a second copy here and an effect writing one into the other on every
  // keystroke, which is the shape that produces "Maximum update depth
  // exceeded" and did, five times over, when a whole transcript arrived in one
  // change. `setEditedText` is plain state in a hook this component calls, so
  // there is no round trip for the caret to jump across.
  const textareaRef = useRef(null);

  // The caret, in code points of the text: where Edit text opens it, and the
  // sentence the Analyze tab opens on (analyzeFocus). It starts at the
  // sentence handed over from Analyze, and moves with a click in the text or
  // the caret in the box.
  const [flash, setFlash] = useState(null);
  const caretRef = useRef(null);
  const flashRef = useRef(null);
  const placeCaret = (at) => {
    caretRef.current = at;
    try {
      analyzeFocus.write({ docId: doc.id, sentenceId: null, begin: null, at });
    } catch {
      /* noop */
    }
  };
  // Read after the commit, never during render: the grid hands its sentence
  // over as it unmounts, which is in the same commit as this tab's mount.
  // Once per mount: React's second run of a mount effect in development would
  // otherwise drop the caret this one handed to Analyze (openTab).
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    const landing = landingFor(doc);
    if (!landing) return;
    try {
      baselineFocus.clear();
    } catch {
      /* noop */
    }
    placeCaret(landing.at);
    setFlash(landing);
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!flash) return undefined;
    flashRef.current?.scrollIntoView?.({ block: 'center' });
    const timer = setTimeout(() => setFlash(null), 2400);
    return () => clearTimeout(timer);
  }, [flash]);
  // Only from the saved text: a caret in a draft counts letters the grid does
  // not have, and the draft may be left unsaved. The box's last caret is kept,
  // and handed over once a save lands with nothing typed since, when the text
  // it counts is the saved text.
  const lastBoxRef = useRef(null);
  const caretFromBox = (el) => {
    const at = utf16ToCp(el.value, el.selectionStart);
    lastBoxRef.current = { text: el.value, at };
    if (el.value === (ops.body || '')) placeCaret(at);
  };
  useEffect(() => {
    const last = lastBoxRef.current;
    if (ops.isEditing || !last || last.text !== (ops.body || '')) return;
    lastBoxRef.current = null;
    placeCaret(last.at);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ops.isEditing, ops.body]);
  const caretFromText = (e) => {
    const sel = window.getSelection?.();
    if (!sel?.rangeCount) return;
    const r = sel.getRangeAt(0);
    if (!e.currentTarget.contains(r.startContainer)) return;
    const before = document.createRange();
    before.selectNodeContents(e.currentTarget);
    before.setEnd(r.startContainer, r.startOffset);
    placeCaret(utf16ToCp(ops.body || '', before.toString().length));
  };

  // Auto-grow the textarea with its content, capped so it doesn't run
  // off-screen on huge documents.
  const autoGrow = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 480)}px`;
  };

  // Fit the box to the text the editor opens with, and give it the caret:
  // Edit text is gone once the editor is open, and a blank document opens
  // straight into it. Closed by Save or Cancel, which go with it, the caret
  // goes back to Edit text.
  const editButtonRef = useRef(null);
  const wasEditing = useRef(ops.isEditing);
  useEffect(() => {
    const opened = ops.isEditing && !wasEditing.current;
    const closed = !ops.isEditing && wasEditing.current;
    wasEditing.current = ops.isEditing;
    const lost = () => !document.activeElement || document.activeElement === document.body;
    if (opened) {
      requestAnimationFrame(() => {
        autoGrow();
        const el = textareaRef.current;
        el?.focus();
        if (el && caretRef.current != null) {
          // The box scrolls to the caret when the text before it runs past
          // the box: that text's height, measured in the box itself, less
          // half the box.
          const full = el.value;
          const u = toUtf16(full, caretRef.current);
          el.value = full.slice(0, u);
          const above = el.scrollHeight;
          el.value = full;
          el.setSelectionRange(u, u);
          el.scrollTop = above > el.clientHeight ? above - el.clientHeight / 2 : 0;
        }
      });
    } else if (closed) {
      requestAnimationFrame(() => {
        if (lost()) editButtonRef.current?.focus();
      });
    }
  }, [ops.isEditing]);

  // A document with no text yet opens straight into the editor: typing the
  // text is the only thing to do here, and a button in front of an empty box
  // is a step nobody needs.
  const emptyOnArrival = !readOnly && !(doc.body || '').trim();
  useEffect(() => {
    if (emptyOnArrival && !ops.isEditing) ops.handleEdit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTextChange = (e) => {
    ops.handleTextChange(e);
    caretFromBox(e.target);
    autoGrow();
  };
  const handleSelect = (e) => {
    ops.editLogHandlers.onSelect(e);
    caretFromBox(e.target);
  };

  const body = ops.body || '';

  return (
    <div className="flex flex-col gap-6 pt-4">
      <div className="rounded-lg border bg-card p-4">
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className={TYPE.card}>Baseline text</h2>
            </div>
            {!ops.isEditing && !readOnly && (
              <Button ref={editButtonRef} variant="outline" size="sm" onClick={ops.handleEdit}>
                <Pencil className="h-4 w-4" /> Edit text
              </Button>
            )}
          </div>

          <div className="border-t" />

          {ops.isEditing ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="baseline-text">Document text</Label>
                <Textarea
                  ref={textareaRef}
                  id="baseline-text"
                  compose
                  value={ops.editedText}
                  {...ops.editLogHandlers}
                  onSelect={handleSelect}
                  onChange={handleTextChange}
                  placeholder="Type or paste the text"
                  readOnly={readOnly}
                  spellCheck={false}
                  rows={10}
                  className="resize-none overflow-auto font-text"
                  required
                />
                {ops.changedElsewhere && (
                  <Notice tone="warning" role="alert">
                    Changed elsewhere in the same passage.
                  </Notice>
                )}
              </div>

              {ops.body?.trim() ? (
                <div className="rounded-md border border-border bg-muted p-3">
                  <div className="flex items-start gap-2">
                    <Info className="mt-0.5 h-4 w-4 shrink-0" />
                    <p className="text-sm">
                      Words inside deleted text are removed with their annotations.
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Each line becomes a sentence. Sentence breaks can be moved later on the Tokenize
                  tab.
                </p>
              )}

              <div className="flex items-center justify-end gap-2">
                <Button variant="outline" onClick={ops.handleCancel} disabled={ops.saving}>
                  <X className="h-4 w-4" /> Cancel
                </Button>
                <Button onClick={ops.handleSave} disabled={ops.saving || readOnly}>
                  <Save className="h-4 w-4" /> {ops.saving ? 'Saving…' : 'Save changes'}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div>
                <div className="rounded-md bg-muted p-4">
                  <p
                    dir="auto"
                    className="whitespace-pre-wrap font-text text-sm"
                    onMouseUp={caretFromText}
                  >
                    {flash ? (
                      <>
                        {body.slice(0, flash.from)}
                        <span ref={flashRef} className="baseline-flash">
                          {body.slice(flash.from, flash.to)}
                        </span>
                        {body.slice(flash.to)}
                      </>
                    ) : (
                      body
                    )}
                  </p>
                </div>
              </div>

              {!ops.primaryTextLayer && (
                <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3">
                  <div className="flex items-start gap-2">
                    <Info className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                    <p className="text-sm text-destructive">{NOT_SET_UP}</p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
