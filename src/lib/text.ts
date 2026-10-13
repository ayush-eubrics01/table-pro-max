// The backend reports offsets in UTF-8 bytes; the editor works in UTF-16 code units.

const encoder = new TextEncoder();

/** UTF-16 index -> UTF-8 byte offset within `text`. */
export function utf16ToByte(text: string, index: number): number {
  return encoder.encode(text.slice(0, Math.max(0, Math.min(index, text.length)))).length;
}

/** UTF-8 byte offset -> UTF-16 index within `text`. */
export function byteToUtf16(text: string, byteOffset: number): number {
  let bytes = 0;
  let i = 0;
  while (i < text.length && bytes < byteOffset) {
    const code = text.codePointAt(i)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    i += code >= 0x10000 ? 2 : 1;
  }
  return i;
}

export function uid(): string {
  return crypto.randomUUID();
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function formatCount(n: number): string {
  return n.toLocaleString();
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}
