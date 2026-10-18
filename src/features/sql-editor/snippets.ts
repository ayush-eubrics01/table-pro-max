import { ifNotIn, snippetCompletion, type CompletionSource } from "@codemirror/autocomplete";
import type { Snippet } from "../../types/backend";

/** Word characters in any alphabet; the backend accepts the same for triggers. */
const WORD = /[\p{L}\p{M}\p{N}_]+/u;

/**
 * CodeMirror's template syntax also treats `#{…}` as a field and drops the backslash of `\{` and
 * `\}`; escape those so only `${field}` is special and everything else is inserted as written.
 */
const template = (body: string) => body.replace(/\\([{}])/g, "\\\\$1").replace(/#\{/g, "#\\{");

/**
 * Completions for the user's snippets: typing a trigger word offers its snippet, which expands
 * with Tab moving between its `${field}`s. Shown alongside the SQL completions, and like them not
 * inside strings, quoted names or comments.
 */
export function snippetSource(snippets: Snippet[]): CompletionSource {
  const options = snippets.map((s) =>
    snippetCompletion(template(s.body), { label: s.trigger, detail: s.name, type: "text", info: s.body, boost: -1 }),
  );
  return ifNotIn(["QuotedIdentifier", "String", "LineComment", "BlockComment", "."], (context) => {
    const word = context.matchBefore(WORD);
    if (!word && !context.explicit) return null;
    return { from: word?.from ?? context.pos, options, validFor: /^[\p{L}\p{M}\p{N}_]*$/u };
  });
}
