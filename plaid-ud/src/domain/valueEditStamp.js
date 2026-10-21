// The stamp a person's edit of a value carries: the writer's (a verifier's
// confirms machine-made material, a contributor's marks it contributed), and,
// when the value changes, provProb removed, since it was the probability of
// the value replaced (the provenance convention). Null when there is nothing
// to write. Typed edits and Grew rewrites both stamp through here.
export function valueEditStamp(writer, metadata, changes = true) {
  const stamp = writer.editStamp(metadata);
  if (!changes || metadata?.provProb == null) return stamp;
  return { ...(stamp || {}), provProb: null };
}
