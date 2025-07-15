export const RowLabel = ({ children, className = '' }) => {
  return (
    <div className={`text-xs font-bold text-gray-700 p-0.5 min-h-7 flex items-center ${className}`}>
      {children}
    </div>
  );
};