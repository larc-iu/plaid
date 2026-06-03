import { useMemo } from 'react';
import { createAvatar } from '@dicebear/core';
import { shapes } from '@dicebear/collection';

// A small, deterministic glyph for an entity (project/document/user), derived
// purely from its UUID — same id always renders the same avatar. Gives UUIDs a
// human-recognizable identity in lists and breadcrumbs without exposing the raw
// id. Uses DiceBear's `shapes` style (https://www.dicebear.com/styles/shapes/):
// clean, colorful, faceless geometry. Pure render: no state, no network — the
// SVG is generated locally and inlined as a data URI.
export const EntityAvatar = ({ id, size = 22, style }) => {
  const uri = useMemo(
    () => createAvatar(shapes, { seed: id || '', size }).toDataUri(),
    [id, size]
  );
  return (
    <img
      src={uri}
      width={size}
      height={size}
      alt=""
      title={id}
      style={{ borderRadius: 4, flexShrink: 0, display: 'block', ...style }}
    />
  );
};
