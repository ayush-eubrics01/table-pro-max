const USER_INFO = /^([a-z][a-z0-9+.-]*:\/\/)([^@/?#]*)@/i;

/** The URL with any password removed from its user info (`scheme://user:pw@host` → `scheme://user@host`). */
export function withoutPassword(url: string): string {
  const m = USER_INFO.exec(url);
  if (!m) return url;
  const user = m[2]!.split(":")[0]!;
  return `${m[1]}${user ? `${user}@` : ""}${url.slice(m[0].length)}`;
}
