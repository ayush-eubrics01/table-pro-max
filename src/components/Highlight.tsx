/** Text with the matched characters of a search marked (positions from `fuzzyMatch`). */
export function Highlight({ text, positions }: { text: string; positions: number[] | undefined }) {
  if (!positions?.length) return <>{text}</>;
  const marked = new Set(positions);
  const parts: { text: string; mark: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const mark = marked.has(i);
    const last = parts[parts.length - 1];
    if (last && last.mark === mark) last.text += text[i];
    else parts.push({ text: text[i]!, mark });
  }
  return <>{parts.map((p, i) => (p.mark ? <mark key={i}>{p.text}</mark> : p.text))}</>;
}
