export const ErrorMessage = ({ message, className = '' }) => {
  if (!message) return null;

  return (
    <div className={`rounded-md bg-red-50 p-4 ${className}`}>
      <div className="flex items-center">
        <svg 
          className="w-5 h-5 text-red-600 mr-2" 
          fill="none" 
          stroke="currentColor" 
          viewBox="0 0 24 24"
        >
          <path 
            strokeLinecap="round" 
            strokeLinejoin="round" 
            strokeWidth={2} 
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.732-.833-2.5 0L4.268 19.5c-.77.833.192 2.5 1.732 2.5z" 
          />
        </svg>
        <p className="text-sm text-red-800">{message}</p>
      </div>
    </div>
  );
};