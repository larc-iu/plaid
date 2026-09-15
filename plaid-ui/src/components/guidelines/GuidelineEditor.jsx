import { useCallback, useEffect, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import {
  Bold,
  Code,
  Heading2,
  Heading3,
  Italic,
  Link2,
  Link2Off,
  List,
  ListOrdered,
  Quote,
  Strikethrough,
  Table as TableIcon,
} from 'lucide-react';
import { Button } from '../ui/button.jsx';
import { Input } from '../ui/input.jsx';
import { Textarea } from '../ui/textarea.jsx';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.jsx';
import { cn } from '../../lib/utils.js';
import { GUIDELINE_EXTENSIONS, serializeMarkdown } from './guidelineMarkdown.js';
import './guidelines.css';

// The body editor. Rich text by default, with the Markdown underneath one
// click away.
//
// This module is the only thing in the package that pulls in Tiptap, and
// `GuidelinesTab` loads it lazily, so a reader who never opens the editor never
// downloads it. Keep it that way: importing this file (or
// `guidelineMarkdown.js`) from the tab itself would put the whole editor in
// every app's main bundle.
//
// What the author types is a Tiptap document; what is SAVED is Markdown, which
// `serializeMarkdown` produces and which `lib/markdown.js` renders for every
// reader. `guidelineMarkdown.js` explains why those two have to agree and
// `guidelineMarkdown.test.js` holds them to it.

/** One toolbar button. `active` draws the pressed state, for a mark that is on. */
const ToolButton = ({ icon: Icon, label, active, disabled, onClick }) => (
  <Button
    type="button"
    variant="ghost"
    size="icon"
    aria-label={label}
    title={label}
    aria-pressed={active}
    disabled={disabled}
    // The toolbar must not take focus from the text: a button that steals the
    // selection applies its mark to nothing.
    onMouseDown={(e) => e.preventDefault()}
    onClick={onClick}
    className={cn('h-8 w-8', active && 'bg-accent text-accent-foreground')}
  >
    <Icon className="h-4 w-4" />
  </Button>
);

/** The link control: a popover holding the URL, since a browser prompt blocks the page. */
const LinkButton = ({ editor }) => {
  const [open, setOpen] = useState(false);
  const [href, setHref] = useState('');
  const linked = editor?.isActive('link');

  const apply = () => {
    const url = href.trim();
    if (!url) return;
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    setOpen(false);
  };

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) setHref(editor?.getAttributes('link')?.href ?? '');
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Link"
            title="Link"
            aria-pressed={linked}
            onMouseDown={(e) => e.preventDefault()}
            className={cn('h-8 w-8', linked && 'bg-accent text-accent-foreground')}
          >
            <Link2 className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-2" align="start">
          <div className="flex gap-2">
            <Input
              autoFocus
              value={href}
              spellCheck={false}
              placeholder="https://"
              aria-label="Address"
              onChange={(e) => setHref(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  apply();
                }
              }}
            />
            <Button type="button" size="sm" onClick={apply}>
              Apply
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      {linked && (
        <ToolButton
          icon={Link2Off}
          label="Remove link"
          onClick={() => editor.chain().focus().extendMarkRange('link').unsetLink().run()}
        />
      )}
    </>
  );
};

/**
 * Edit one guideline body.
 *
 * `value` is Markdown and `onChange` is handed Markdown. The component holds
 * the Tiptap document in between, so a parent never sees the editor's shape.
 */
export function GuidelineEditor({ value, onChange, disabled }) {
  const [source, setSource] = useState(false);

  const editor = useEditor(
    {
      extensions: GUIDELINE_EXTENSIONS,
      content: value ?? '',
      contentType: 'markdown',
      editable: !disabled,
      // The editor mounts in an effect rather than during render, which is what
      // React 19's stricter double-render wants.
      immediatelyRender: false,
      editorProps: {
        attributes: {
          class: 'guideline-editor__doc md-body',
          // Language data goes in a guideline, and half of it is not English.
          spellcheck: 'false',
        },
      },
      onUpdate: ({ editor: ed }) => onChange(serializeMarkdown(ed.getJSON())),
    },
    // Rebuilding on `disabled` alone; `value` is deliberately absent, since
    // reloading content on every keystroke would fight the cursor.
    [disabled],
  );

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
  }, [editor, disabled]);

  // Coming back from the source view, the text typed there is the document.
  const leaveSource = useCallback(() => {
    setSource(false);
    if (editor) editor.commands.setContent(value ?? '', { contentType: 'markdown' });
  }, [editor, value]);

  if (source) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Markdown</span>
          <Button type="button" variant="outline" size="sm" onClick={leaveSource}>
            Rich text
          </Button>
        </div>
        <Textarea
          value={value ?? ''}
          disabled={disabled}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          className="min-h-[24rem] font-mono text-xs"
          aria-label="Markdown"
        />
      </div>
    );
  }

  const chain = () => editor.chain().focus();

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-0.5 rounded-md border bg-muted/40 p-1">
        <ToolButton
          icon={Bold}
          label="Bold"
          active={editor?.isActive('bold')}
          onClick={() => chain().toggleBold().run()}
        />
        <ToolButton
          icon={Italic}
          label="Italic"
          active={editor?.isActive('italic')}
          onClick={() => chain().toggleItalic().run()}
        />
        <ToolButton
          icon={Strikethrough}
          label="Strikethrough"
          active={editor?.isActive('strike')}
          onClick={() => chain().toggleStrike().run()}
        />
        <ToolButton
          icon={Code}
          label="Code"
          active={editor?.isActive('code')}
          onClick={() => chain().toggleCode().run()}
        />
        <span className="mx-1 h-5 w-px bg-border" />
        <ToolButton
          icon={Heading2}
          label="Heading"
          active={editor?.isActive('heading', { level: 2 })}
          onClick={() => chain().toggleHeading({ level: 2 }).run()}
        />
        <ToolButton
          icon={Heading3}
          label="Subheading"
          active={editor?.isActive('heading', { level: 3 })}
          onClick={() => chain().toggleHeading({ level: 3 }).run()}
        />
        <span className="mx-1 h-5 w-px bg-border" />
        <ToolButton
          icon={List}
          label="Bulleted list"
          active={editor?.isActive('bulletList')}
          onClick={() => chain().toggleBulletList().run()}
        />
        <ToolButton
          icon={ListOrdered}
          label="Numbered list"
          active={editor?.isActive('orderedList')}
          onClick={() => chain().toggleOrderedList().run()}
        />
        <ToolButton
          icon={Quote}
          label="Quote"
          active={editor?.isActive('blockquote')}
          onClick={() => chain().toggleBlockquote().run()}
        />
        <ToolButton
          icon={TableIcon}
          label="Table"
          active={editor?.isActive('table')}
          onClick={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
        />
        <span className="mx-1 h-5 w-px bg-border" />
        <LinkButton editor={editor} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => setSource(true)}
        >
          Markdown
        </Button>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
