// `@` is left as it is: a path segment may hold one (RFC 3986), and an email
// stays readable in a URL and a log.
const segment = (value) => encodeURIComponent(String(value)).replace(/%40/g, "@");

/**
 * The one way this client builds a request path: a tagged template whose
 * every `${value}` is one path segment, percent-encoded. An id is put in a
 * URL as it is only while it holds no `?`, `#`, `/`, `%` or space. A user id
 * is an email, which may hold any of them, and unencoded `carol@x.org?z`
 * named `carol@x.org` to the server: a role change or a deactivation meant
 * for one account landed on another (ACL5-2). The Python client's twin is
 * `plaid_client.http.api_path`.
 *
 *   apiPath`/api/v1/projects/${projectId}/writers/${userId}`
 *
 * A query string is never a segment: add it after, outside the template.
 * @param {TemplateStringsArray} strings
 * @param {...unknown} values
 * @returns {string}
 */
export function apiPath(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += segment(values[i]) + strings[i + 1];
  }
  return out;
}
