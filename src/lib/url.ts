const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * The URL with any password removed from its user info (`scheme://user:pw@host` → `scheme://user@host`).
 * Unencoded passwords may contain `/ ? # @`, so the user info runs to the last `@`. When in doubt the
 * result may lose part of the URL, but never keeps any part of a password.
 */
export function withoutPassword(url: string): string {
  const scheme = SCHEME.exec(url)?.[0];
  if (!scheme) return ADO_START.test(url) ? adoWithoutPassword(url) : url;
  const rest = url.slice(scheme.length);
  const at = rest.lastIndexOf("@");
  if (at < 0) return url;
  const info = rest.slice(0, at);
  const colon = info.indexOf(":");
  if (colon < 0) return url;
  const user = info.slice(0, colon);
  return `${scheme}${user ? `${user}@` : ""}${rest.slice(at + 1)}`;
}

/** SQL Server's ADO.NET connection strings: `Server=host,port;Database=…;User ID=…;Password=…`. */
const ADO_START = /^\s*(server|data source|address|addr|network address)\s*=/i;

/** A connection URL (`scheme://…`) or an ADO.NET connection string, rather than search text. */
export function isConnectionString(text: string): boolean {
  const t = text.trim();
  return /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(t) || ADO_START.test(t);
}

/** Drops `Password=` / `Pwd=` pairs, whose value may be `{…}` (with `}}`), quoted, or run to `;`.
 *  An unclosed value drops the rest of the string rather than keep part of a password. */
function adoWithoutPassword(s: string): string {
  const kept: string[] = [];
  let i = 0;
  while (i < s.length) {
    const eq = s.indexOf("=", i);
    if (eq < 0) {
      kept.push(s.slice(i));
      break;
    }
    const key = s.slice(i, eq).trim();
    let j = eq + 1;
    while (s[j] === " ") j++;
    let end: number;
    if (s[j] === "{") {
      end = s.length;
      for (let k = j + 1; k < s.length; k++) {
        if (s[k] !== "}") continue;
        if (s[k + 1] === "}") {
          k++;
          continue;
        }
        end = k + 1;
        break;
      }
    } else if (s[j] === '"' || s[j] === "'") {
      const close = s.indexOf(s.charAt(j), j + 1);
      end = close < 0 ? s.length : close + 1;
    } else {
      end = s.indexOf(";", j);
      if (end < 0) end = s.length;
    }
    const semi = s.indexOf(";", end);
    const stop = semi < 0 ? s.length : semi;
    if (!/^(password|pwd)$/i.test(key)) kept.push(s.slice(i, stop).trim());
    i = stop + 1;
  }
  return kept.filter(Boolean).join(";");
}
