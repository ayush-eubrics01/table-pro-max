import { afterEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { useSnippets } from "./snippets";

const sel = { id: "builtin-sel", trigger: "sel", name: "Select rows", body: "SELECT ${columns} FROM ${table};" };
const cnt = { id: "s1", trigger: "cnt", name: "Count rows", body: "SELECT count(*) FROM ${table};" };

afterEach(() => {
  clearMocks();
  useSnippets.setState({ snippets: [], loaded: false });
});

describe("useSnippets", () => {
  it("keeps the newest list when an older read answers last", async () => {
    let list = [sel];
    let release: () => void = () => undefined;
    let first = true;
    mockIPC(async (cmd, args) => {
      if (cmd === "list_snippets") {
        const answer = list;
        if (first) {
          first = false;
          await new Promise<void>((r) => (release = r));
        }
        return answer;
      }
      if (cmd === "save_snippet") list = [...list, (args as { snippet: typeof cnt }).snippet];
      return null;
    });
    const loading = useSnippets.getState().load();
    await useSnippets.getState().save(cnt);
    release();
    await loading;
    expect(useSnippets.getState().snippets.map((s) => s.trigger)).toEqual(["sel", "cnt"]);
  });
});
