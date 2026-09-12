import { useId } from 'react';

// Plaid's marks: one cloth, cut two ways.
//
// A swatch of plaid, because the platform is called Plaid and because an
// interlinear text IS a weave, rows of annotation crossing columns of words.
// A sett rather than a drawn grid, because a grid of even lines reads as a hash
// at the size these are actually used and "#" already means a homograph number
// here. What makes cloth read as cloth is bands of UNEQUAL width.
//
// `PlaidMark` is the product: a square swatch, for an app header or a favicon.
// `AssistantMark` is the same cloth cut ROUND, for the assistant. They must not
// be the same glyph: an app header carries both at once, a screen apart, and one
// mark doing two jobs reads as a repetition rather than as a family. The circle
// also happens to be what it is beside a reply, which is an avatar.
//
// Fixed colours, not `currentColor`. The three bands are what make these legible
// at 14px, and a single-colour version of the same geometry goes to grey mush
// below about 20px. The slate ground has enough value contrast to sit on a light
// card and a dark one, which is what ruled out the traditional dark tartans:
// Black Watch is beautiful at 72px and one dark square at 14.
//
// Changing the geometry is a design change, not a tidy-up, and it FAILS SILENTLY:
// it will still look fine at 72px in a review. Check 14px and 16px, on both
// grounds, before and after.
const GROUND = '#1e293b';
const WARP = '#7f1d1d'; // oxblood, the broad band on each axis
const WEFT = '#4d7c0f'; // sage, the narrow band
const CHECK = '#d6d3d1'; // bone, the fine overcheck that gives it a catch-light

// One clip per instance. These appear several times on a screen (a header, a
// reply, a picker), and a shared id is invalid markup that browsers resolve by
// document order rather than by intent.
const Sett = ({ clipShape, rim = null, className, title }) => {
  const clip = useId();
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      <defs>
        <clipPath id={clip}>{clipShape}</clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <rect x="2.5" y="2.5" width="19" height="19" fill={GROUND} />
        <rect x="2.5" y="2.5" width="6.5" height="19" fill={WARP} opacity="0.72" />
        <rect x="2.5" y="2.5" width="19" height="6.5" fill={WARP} opacity="0.72" />
        <rect x="14.2" y="2.5" width="2.6" height="19" fill={WEFT} opacity="0.5" />
        <rect x="2.5" y="14.2" width="19" height="2.6" fill={WEFT} opacity="0.5" />
        <rect x="11.4" y="2.5" width="0.9" height="19" fill={CHECK} opacity="0.85" />
        <rect x="2.5" y="11.4" width="19" height="0.9" fill={CHECK} opacity="0.85" />
      </g>
      {rim}
    </svg>
  );
};

// The product's mark. A crisper corner than the assistant's circle, so the two
// silhouettes part company at 14px rather than both reading as "roundish".
export const PlaidMark = (props) => (
  <Sett {...props} clipShape={<rect x="2.5" y="2.5" width="19" height="19" rx="3" />} />
);

// The assistant's mark.
//
// `ring` puts a hairline rim just outside the cloth, which is drawn INSIDE the
// svg: a CSS ring sits on the element's box, and the disc is 19 of 24 units
// across, so it would float off the edge and read as detached. The cloth shrinks
// by half a unit to make room rather than the rim covering the outermost band.
//
// Opt-in, and off at the small sizes ON PURPOSE. Measured at 14, 16, 20, 28, 40
// and 72: the rim looks properly finished from about 28 up, and below 20 it is
// sub-pixel, so all it does is soften the perimeter and make the disc read
// smaller. So the header, the buttons and the Ask gestures go without, and the
// two places that render it big use it. (A drop shadow was tried and is worse
// at every size: a visible halo, and at 14px it reads as a smudge.)
export const AssistantMark = ({ ring = false, ...props }) => (
  <Sett
    {...props}
    clipShape={<circle cx="12" cy="12" r={ring ? 9 : 9.5} />}
    rim={
      ring ? (
        <circle cx="12" cy="12" r="9.35" stroke={CHECK} strokeWidth="0.6" opacity="0.38" />
      ) : null
    }
  />
);
