// A project's services, read once for every part of the page that asks at the
// same moment. A document page mounts several readers of the list (the
// service request hook of each tab, the assistant's availability and its
// choice) and each asks on mount and on its own poll, so one open sent the
// same request up to twelve times (SCL3-6). A call made while the same read
// is out shares it. Nothing is kept once it lands: the next call reads again.

const out = new Map();

// The same server and login, or the same client object when it names none
// (a test's fake).
const loginOf = (client) =>
  typeof client?.token === 'string' ? `${client.baseUrl}\u0000${client.token}` : client;

/** `client.messages.discoverServices(projectId)`, shared while it is out. */
export function discoverServices(client, projectId) {
  const who = loginOf(client);
  let reads = out.get(who);
  if (!reads) out.set(who, (reads = new Map()));
  let read = reads.get(projectId);
  if (!read) {
    // Asked at once, as the caller would have: a throw becomes a rejection.
    try {
      read = Promise.resolve(client.messages.discoverServices(projectId));
    } catch (err) {
      read = Promise.reject(err);
    }
    read = read.finally(() => {
      reads.delete(projectId);
      if (!reads.size && out.get(who) === reads) out.delete(who);
    });
    reads.set(projectId, read);
  }
  // Each caller gets a list of its own.
  return read.then((list) => (Array.isArray(list) ? [...list] : list));
}
