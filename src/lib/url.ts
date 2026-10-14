const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * The URL with any password removed from its user info (`scheme://user:pw@host` → `scheme://user@host`).
 * Unencoded passwords may contain `/ ? # @`, so the user info runs to the last `@`. When in doubt the
 * result may lose part of the URL, but never keeps any part of a password.
 */
export function withoutPassword(url: string): string {
  const scheme = SCHEME.exec(url)?.[0];
  if (!scheme) return url;
  const rest = url.slice(scheme.length);
  const at = rest.lastIndexOf("@");
  if (at < 0) return url;
  const info = rest.slice(0, at);
  const colon = info.indexOf(":");
  if (colon < 0) return url;
  const user = info.slice(0, colon);
  return `${scheme}${user ? `${user}@` : ""}${rest.slice(at + 1)}`;
}
