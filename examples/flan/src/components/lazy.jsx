import { useRef, useEffect, useState } from 'react'

export default function Lazy({ children, className, style, rootMargin, contentPreview }) {
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
                rootMargin: rootMargin || '100px'
            }
        );

        if (ref.current) {
            observer.observe(ref.current);
        }

        return () => observer.disconnect();
    }, []);

    let mergedStyle = {minHeight: '30px'};
    Object.assign(mergedStyle, style)

    return (
        <div ref={ref} className={className || ""}>
            {isVisible ? children : (
                <div style={mergedStyle}>
                    {contentPreview}
                </div>
            )}
        </div>
    );
}
