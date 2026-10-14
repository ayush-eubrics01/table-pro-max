// JSON checking and formatting for the value editor. Formatting re-emits the original
// tokens, so numbers like 12345678901234567890 or 1.0 and string escapes never change.

export type JsonCheck = { ok: true } | { ok: false; line: number; column: number; message: string };

class JsonError extends Error {
  constructor(
    message: string,
    public pos: number,
  ) {
    super(message);
  }
}

type Tok = { kind: "{" | "}" | "[" | "]" | ":" | "," | "lit"; text: string; pos: number };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
    } else if ("{}[]:,".includes(ch)) {
      toks.push({ kind: ch as Tok["kind"], text: ch, pos: i });
      i++;
    } else if (ch === '"') {
      const start = i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\") {
          const e = src[i + 1];
          if (e === "u") {
            if (!/^[0-9a-fA-F]{4}$/.test(src.slice(i + 2, i + 6))) throw new JsonError("Bad \\u escape", i);
            i += 6;
            continue;
          }
          if (e === undefined || !'"\\/bfnrt'.includes(e)) throw new JsonError("Bad escape", i);
          i += 2;
          continue;
        }
        if (src.charCodeAt(i) < 0x20) throw new JsonError("Control character in string", i);
        i++;
      }
      if (i >= src.length) throw new JsonError("Unterminated string", start);
      i++;
      toks.push({ kind: "lit", text: src.slice(start, i), pos: start });
    } else {
      const m = /^(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(src.slice(i));
      if (!m) throw new JsonError(`Unexpected character '${ch}'`, i);
      toks.push({ kind: "lit", text: m[0], pos: i });
      i += m[0].length;
    }
  }
  return toks;
}

/** Parses tokens into the same token stream, checking structure; returns the formatted text. */
function format(src: string): string {
  const toks = tokenize(src);
  if (toks.length === 0) throw new JsonError("Empty document", 0);
  let k = 0;
  const out: string[] = [];
  const peek = () => toks[k];
  const fail = (msg: string): never => {
    throw new JsonError(msg, peek()?.pos ?? src.length);
  };
  const value = (depth: number): void => {
    const t = peek() ?? fail("Unexpected end of document");
    const pad = (d: number) => "  ".repeat(d);
    if (t.kind === "lit") {
      out.push(t.text);
      k++;
    } else if (t.kind === "{" || t.kind === "[") {
      const close = t.kind === "{" ? "}" : "]";
      k++;
      if (peek()?.kind === close) {
        out.push(t.kind + close);
        k++;
        return;
      }
      out.push(t.kind + "\n");
      for (;;) {
        out.push(pad(depth + 1));
        if (t.kind === "{") {
          const key = peek();
          if (!key || key.kind !== "lit" || !key.text.startsWith('"')) fail("Expected a property name");
          out.push(key!.text);
          k++;
          if (peek()?.kind !== ":") fail("Expected ':'");
          k++;
          out.push(": ");
        }
        value(depth + 1);
        const sep = peek() ?? fail(`Expected ',' or '${close}'`);
        if (sep.kind === ",") {
          k++;
          if (peek()?.kind === close) fail("Trailing comma");
          out.push(",\n");
        } else if (sep.kind === close) {
          k++;
          out.push("\n" + pad(depth) + close);
          return;
        } else {
          fail(`Expected ',' or '${close}'`);
        }
      }
    } else {
      fail(`Unexpected '${t.text}'`);
    }
  };
  value(0);
  if (k < toks.length) fail("Unexpected text after the document");
  return out.join("");
}

function position(src: string, pos: number): { line: number; column: number } {
  const before = src.slice(0, pos);
  const line = before.split("\n").length;
  return { line, column: pos - before.lastIndexOf("\n") };
}

export function validateJson(text: string): JsonCheck {
  try {
    format(text);
    return { ok: true };
  } catch (e) {
    // Pathologically deep nesting exhausts the parser's stack; report it, don't crash the editor.
    if (e instanceof RangeError) return { ok: false, line: 1, column: 1, message: "Nested too deeply to check" };
    if (!(e instanceof JsonError)) throw e;
    return { ok: false, ...position(text, e.pos), message: e.message };
  }
}

export function formatJson(text: string): string {
  return format(text);
}
