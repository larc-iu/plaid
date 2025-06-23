import './TokenVisualizer.css';

export const TokenVisualizer = ({ text, tokens }) => {
  if (!text) {
    return (
      <div className="token-visualizer empty">
        <p>No text to visualize</p>
      </div>
    );
  }

  if (tokens.length === 0) {
    return (
      <div className="token-visualizer">
        <div className="raw-text">{text}</div>
        <p className="no-tokens">No tokens yet. Click "Whitespace Tokenize" to create tokens.</p>
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
          <span key={`between-${index}`} className="between-text">
            {betweenText}
          </span>
        );
      }

      // Add the token itself
      const tokenText = text.slice(token.begin, token.end);
      elements.push(
        <span 
          key={`token-${token.id || index}`}
          className="token"
          title={`Token ${token.precedence || index + 1}: "${tokenText}" [${token.begin}-${token.end}]${token.id ? ` (ID: ${token.id})` : ''}`}
        >
          {tokenText}
          <span className="token-index">{token.precedence || index + 1}</span>
        </span>
      );

      lastEnd = token.end;
    });

    // Add any remaining text after the last token
    if (lastEnd < text.length) {
      const remainingText = text.slice(lastEnd);
      elements.push(
        <span key="remaining" className="between-text">
          {remainingText}
        </span>
      );
    }

    return elements;
  };

  return (
    <div className="token-visualizer">
      <div className="tokenized-text">
        {renderTokenizedText()}
      </div>
      
      <div className="token-info">
        <h4>Token Details</h4>
        <div className="token-grid">
          {sortedTokens.map((token, index) => {
            const tokenText = text.slice(token.begin, token.end);
            return (
              <div key={token.id || index} className="token-detail">
                <span className="token-number">{token.precedence || index + 1}</span>
                <span className="token-form">"{tokenText}"</span>
                <span className="token-position">[{token.begin}-{token.end}]</span>
                {token.id && <span className="token-id">ID: {token.id}</span>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};