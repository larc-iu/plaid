import { useRef } from 'react';

// A textarea with syntax highlighting behind it: the text is painted once by
// `highlight` into a <pre>, and a transparent textarea sits exactly on top so
// the caret, selection, spellcheck and IME are all the browser's own.
//
// This replaces react-simple-code-editor, which did the same thing but is
// CommonJS, unmaintained, and declares no React 19 support. Vite 8's dependency
// optimizer hands its `exports` object over as the module's default rather than
// unwrapping `exports.default`, so the component arrived as an object and the
// Search screen died with "Element type is invalid". The production build
// unwrapped it correctly, which is the worst shape a dependency can have: right
// in the build, wrong in the browser you develop in.
//
// The two things worth knowing about the layering:
//   - The <pre> and the <textarea> must agree on every metric that decides
//     where a glyph lands (font, size, line height, padding, wrapping, tabs),
//     or the caret drifts from the text under it. They share one style object.
//   - Tab is inserted with `execCommand('insertText')`, not by assigning
//     `value`. An assignment wipes the browser's undo stack; this keeps it, so
//     Ctrl/Cmd+Z still works and no history of our own is needed.

const SHARED = {
  margin: 0,
  border: 0,
  background: 'none',
  boxSizing: 'border-box',
  display: 'block',
  overflow: 'hidden',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'break-word',
  tabSize: 2,
};

export const CodeEditor = ({
  value,
  onValueChange,
  highlight,
  onKeyDown,
  padding = 0,
  textareaId,
  placeholder,
  spellCheck = false,
  style,
}) => {
  const textareaRef = useRef(null);

  const handleKeyDown = (e) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      document.execCommand('insertText', false, '\t');
    }
  };

  // A trailing newline has no line box of its own, so the <pre> would be one
  // line shorter than the textarea and the box would jump as you press Enter.
  const painted = value.endsWith('\n') ? `${value}\n` : value;

  return (
    <div style={{ position: 'relative', textAlign: 'left' }}>
      <pre
        aria-hidden="true"
        style={{ ...SHARED, ...style, padding, position: 'relative', pointerEvents: 'none' }}
        dangerouslySetInnerHTML={{ __html: highlight(painted) }}
      />
      <textarea
        ref={textareaRef}
        id={textareaId}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        spellCheck={spellCheck}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        data-gramm={false}
        style={{
          ...SHARED,
          ...style,
          padding,
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          resize: 'none',
          // The glyphs come from the <pre> underneath; only the caret, the
          // selection and the placeholder are the textarea's own. `color`
          // rather than `-webkit-text-fill-color`, because the latter takes
          // the placeholder with it.
          color: 'transparent',
          caretColor: 'hsl(var(--foreground))',
          outline: 'none',
        }}
      />
    </div>
  );
};
