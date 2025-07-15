import { forwardRef } from 'react';

const Input = forwardRef(({ 
  type = 'text', 
  variant = 'default', 
  size = 'medium', 
  error = false, 
  className = '', 
  ...props 
}, ref) => {
  const baseClasses = 'block w-full rounded-md shadow-sm placeholder-gray-400 focus:outline-none disabled:bg-gray-100 disabled:cursor-not-allowed transition-colors';
  
  const variants = {
    default: 'border-gray-300 focus:ring-blue-500 focus:border-blue-500',
    error: 'border-red-300 focus:ring-red-500 focus:border-red-500',
    success: 'border-green-300 focus:ring-green-500 focus:border-green-500'
  };

  const sizes = {
    small: 'px-2 py-1 text-sm',
    medium: 'px-3 py-2 text-sm',
    large: 'px-4 py-3 text-base'
  };

  const currentVariant = error ? 'error' : variant;

  return (
    <input
      ref={ref}
      type={type}
      className={`${baseClasses} ${variants[currentVariant]} ${sizes[size]} border ${className}`}
      {...props}
    />
  );
});

Input.displayName = 'Input';

export { Input };