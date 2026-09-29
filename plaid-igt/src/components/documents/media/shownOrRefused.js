// Every write shows before the server answers, so a screen moves on the moment
// its edit is on the document, not when the server has it: true then, while
// the send goes on in the background (a refusal from the server reloads the
// document and says why). A write refused before it could show (a check, or
// no permission) moved nothing and answers false.
export const shownOrRefused = async (doc, write) => {
  const before = doc.dataVersion;
  const saving = write();
  return doc.dataVersion !== before || (await saving);
};
