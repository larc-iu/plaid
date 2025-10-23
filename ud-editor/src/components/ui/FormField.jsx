import { Input } from './Input';

export const FormField = ({ 
  label, 
  error, 
  helpText, 
  required = false, 
  className = '', 
  children,
  ...props 
}) => {
  const fieldId = props.id || props.name || 'field';
  
  return (
    <div className={`space-y-1 ${className}`}>
      {label && (
        <label 
          htmlFor={fieldId} 
          className="block text-sm font-medium text-gray-700"
        >
          {label}
          {required && <span className="text-red-500 ml-1">*</span>}
        </label>
      )}
      
      {children ? (
        children
      ) : (
        <Input
          id={fieldId}
          error={!!error}
          {...props}
        />
      )}
      
      {error && (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      )}
      
      {helpText && !error && (
        <p className="text-sm text-gray-500">
          {helpText}
        </p>
      )}
    </div>
  );
};