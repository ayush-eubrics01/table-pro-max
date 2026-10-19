// Hex text for binary values: what users paste from databases and tools, as plain digits.

/**
 * The hex digits (lower case, no prefix) of a value written as `deadbeef`, `\xdeadbeef`,
 * `0xDEADBEEF` or `X'DEADBEEF'`, with any spaces or colons between bytes; null when it isn't
 * whole bytes of hex. Empty means zero bytes.
 */
export function parseHex(input: string): string | null {
  let s = input.trim();
  const quoted = /^[xX]'(.*)'$/s.exec(s);
  if (quoted) s = quoted[1]!;
  else if (/^(\\x|0x)/i.test(s)) s = s.slice(2);
  s = s.replace(/[\s:]+/g, "");
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) return null;
  return s.toLowerCase();
}
