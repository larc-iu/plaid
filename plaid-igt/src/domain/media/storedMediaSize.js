// The size in bytes of the recording a document holds, or null when it has
// none or it cannot be read. One byte of it is read through its media link,
// and the size is the total of the answer's Content-Range.
export async function storedMediaSize(client, documentId) {
  try {
    const { url } = await client.documents.mediaLink(documentId);
    const res = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    await res.body?.cancel();
    const total = Number(res.headers.get('content-range')?.split('/')[1]);
    return res.status === 206 && Number.isInteger(total) ? total : null;
  } catch {
    return null;
  }
}
