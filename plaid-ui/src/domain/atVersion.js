// Run `send` with every write it makes carrying `version` of document `docId`
// (the client's strict mode), so the server refuses the whole write when the
// document changed since that version was read. A bulk action sends at the
// version its preview read, never at whatever the client has learned since
// (conc D8): a response naming a newer version of the document between the
// preview and the apply moves the client's copy on. A document with no
// version known is never written unchecked. Imports nothing, so plain node
// reaches it.
export async function atVersion(client, docId, version, send) {
  if (version == null) throw new Error('The document was read with no version.');
  client.documentVersions = { ...client.documentVersions, [docId]: version };
  client.enterStrictMode(docId);
  try {
    return await send();
  } finally {
    client.exitStrictMode();
  }
}
