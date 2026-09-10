import { useRef, useEffect, useState } from 'react';

export default function Lazy({ children, className, style, rootMargin, contentPreview, ...rest }) {
  const [isVisible, setIsVisible] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      {
        threshold: 0,
        rootMargin: rootMargin || '100px',
      },
    );

    if (ref.current) {
      observer.observe(ref.current);
    }

    return () => observer.disconnect();
  }, [rootMargin]);

  let mergedStyle = { minHeight: '30px' };
  Object.assign(mergedStyle, style);

  return (
    <div ref={ref} className={className} style={mergedStyle} {...rest}>
      {isVisible ? children : contentPreview}
    </div>
  );
}
