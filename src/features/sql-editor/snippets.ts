import { snippetCompletion, type CompletionSource } from "@codemirror/autocomplete";
import type { Snippet } from "../../types/backend";

/**
 * Completions for the user's snippets: typing a trigger word offers its snippet, which expands
 * with Tab moving between its `${field}`s. Shown alongside the SQL completions.
 */
export function snippetSource(snippets: Snippet[]): CompletionSource {
  const options = snippets.map((s) =>
    snippetCompletion(s.body, { label: s.trigger, detail: s.name, type: "text", info: s.body, boost: -1 }),
  );
  return (context) => {
    const word = context.matchBefore(/\w+/);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    return { from: word.from, options, validFor: /^\w*$/ };
  };
}
