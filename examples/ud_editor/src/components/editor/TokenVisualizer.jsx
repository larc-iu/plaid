export const TokenVisualizer = ({ text, tokens }) => {
  if (!text) {
    return (
      <div className="text-center py-8 text-gray-500">
        <p>No text to visualize</p>
      </div>
    );
  }

  if (tokens.length === 0) {
    return (
      <div>
        <div className="p-4 bg-white rounded border border-gray-200 font-mono text-sm whitespace-pre-wrap">{text}</div>
        <p className="mt-4 text-sm text-gray-500 text-center">No tokens yet. Click "Whitespace Tokenize" to create tokens.</p>
      </div>
    );
  }

  // Sort tokens by begin position to ensure proper order
  const sortedTokens = [...tokens].sort((a, b) => a.begin - b.begin);

  // Build visualization with highlighted tokens
  const renderTokenizedText = () => {
    const elements = [];
    let lastEnd = 0;

    sortedTokens.forEach((token, index) => {
      // Add any text before this token (spaces, punctuation, etc.)
      if (token.begin > lastEnd) {
        const betweenText = text.slice(lastEnd, token.begin);
        elements.push(
          <span key={`between-${index}`} className="text-gray-400">
            {betweenText}
          </span>
        );
      }

      // Add the token itself
      const tokenText = text.slice(token.begin, token.end);
      elements.push(
        <span 
          key={`token-${token.id || index}`}
          className="relative inline-block px-1 py-0.5 mx-0.5 bg-blue-100 border border-blue-300 rounded cursor-help hover:bg-blue-200 transition-colors"
          title={`Token ${token.precedence || index + 1}: "${tokenText}" [${token.begin}-${token.end}]${token.id ? ` (ID: ${token.id})` : ''}`}
        >
          {tokenText}
          <span className="absolute -top-2 -right-2 text-xs bg-blue-600 text-white rounded-full w-5 h-5 flex items-center justify-center">{token.precedence || index + 1}</span>
        </span>
      );

      lastEnd = token.end;
    });

    // Add any remaining text after the last token
    if (lastEnd < text.length) {
      const remainingText = text.slice(lastEnd);
      elements.push(
        <span key="remaining" className="text-gray-400">
          {remainingText}
        </span>
      );
    }

    return elements;
  };

  return (
    <div>
      <div className="p-4 bg-white rounded border border-gray-200 font-mono text-sm leading-relaxed">
        {renderTokenizedText()}
      </div>
      
      <div className="mt-6">
        <h4 className="text-sm font-semibold text-gray-700 mb-3">Token Details</h4>
        <div className="grid grid-cols-1 gap-2 max-h-48 overflow-y-auto">
          {sortedTokens.map((token, index) => {
            const tokenText = text.slice(token.begin, token.end);
            return (
              <div key={token.id || index} className="flex items-center gap-3 text-sm p-2 bg-gray-50 rounded">
                <span className="font-bold text-blue-600 w-8">{token.precedence || index + 1}</span>
                <span className="font-mono">"{tokenText}"</span>
                <span className="text-gray-500">[{token.begin}-{token.end}]</span>
                {token.id && <span className="text-xs text-gray-400">ID: {token.id}</span>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};