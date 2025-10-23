import { useState } from 'react';

export const FeatureTag = ({ 
  feature, 
  onDelete, 
  className = '' 
}) => {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div 
      className={`
        flex items-center gap-1 text-xs rounded-sm transition-colors duration-200
        ${isHovered 
          ? 'bg-red-200 border border-red-500' 
          : 'bg-transparent border border-transparent'
        }
        ${className}
      `}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <span className="flex-1 font-sans text-center">
        {feature}
      </span>
      {onDelete && (
        <button
          onClick={onDelete}
          className={`
            text-red-500 text-xs font-bold border-none bg-none cursor-pointer 
            transition-opacity duration-200 w-3.5 h-3.5 flex items-center 
            justify-center rounded-sm hover:bg-red-200
            ${isHovered ? 'opacity-100' : 'opacity-0'}
          `}
        >
          ×
        </button>
      )}
    </div>
  );
};

export const FeatureInput = ({ 
  value, 
  onChange, 
  onSubmit, 
  placeholder = "Add feature...",
  className = '' 
}) => {
  return (
    <div className={`flex items-center gap-0.5 ${className}`}>
      <input
        type="text"
        value={value}
        onChange={onChange}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            onSubmit();
          }
        }}
        placeholder={placeholder}
        className="flex-1 text-xs border border-purple-500 rounded-sm px-1 py-0.5 outline-none"
      />
    </div>
  );
};

export const FeatureAddButton = ({ 
  onClick, 
  className = '' 
}) => {
  return (
    <button
      onClick={onClick}
      className={`
        text-xs text-gray-500 px-1 py-0.5 border border-dashed border-gray-500 
        rounded-sm w-full bg-transparent cursor-pointer opacity-100 
        transition-opacity duration-200 hover:opacity-80
        ${className}
      `}
    >
      + Add
    </button>
  );
};