import { forwardRef } from 'react';

export const EditableField = forwardRef(({ 
  value, 
  placeholder = '', 
  isEmpty = false, 
  className = '', 
  ...props 
}, ref) => {
  return (
    <div
      ref={ref}
      className={`
        px-1 py-0.5 text-xs border border-transparent rounded-sm cursor-text 
        min-h-4.5 text-center outline-none whitespace-nowrap bg-transparent 
        font-inherit box-border transition-colors duration-200
        focus:border-blue-500 focus:bg-white
        ${isEmpty ? 'text-gray-400 italic' : 'text-black'}
        ${className}
      `}
      {...props}
    >
      {value || placeholder}
    </div>
  );
});

EditableField.displayName = 'EditableField';