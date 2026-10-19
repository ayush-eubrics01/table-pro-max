// End-to-end: the built app driven through its UI (WebDriver), against a SQLite file made here.
// One session, steps in order, as a user would go: each step starts where the last one ended.
// Run: npm run e2e (see harness.mjs for what it needs).

import { after, before, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { launch } from "./harness.mjs";
import { Key } from "./webdriver.mjs";

let app;
let s;
let db;

before(async () => {
  app = await launch();
  s = app.session;
  db = join(app.dir, "shop.sqlite");
  const seed = new DatabaseSync(db);
  seed.exec(`
    CREATE TABLE customers (id integer PRIMARY KEY, name text NOT NULL, city text);
    INSERT INTO customers VALUES (1, 'Ada', 'London'), (2, 'Grace', 'Paris'), (3, 'Linus', 'Paris');
  `);
  seed.close();
});

after(async () => {
  await app?.stop();
});

/** A cell of the grid on screen: `row` and `col` count from 1 (the row-number column not included). */
const cell = (row, col) => `[role="row"][aria-rowindex="${row + 1}"] [role="gridcell"][aria-colindex="${col + 1}"]`;

/** Runs a step; on failure saves a screenshot named after it. */
async function step(name, fn) {
  try {
    await fn();
  } catch (e) {
    const shot = await app.snapshot(name.replace(/\W+/g, "-"));
    throw new Error(`${name}: ${e.message}${shot ? ` (screenshot: ${shot})` : ""}`, { cause: e });
  }
}

/** Puts `sql` in the active query editor (replacing what's there) and runs it with Ctrl+Enter. */
async function runSql(sql) {
  await s.click(".cm-content", null);
  await s.keys(Key.Control, "a");
  await s.type(".cm-content", null, sql);
  await s.keys(Key.Control, Key.Enter);
}

test("a user's main flows work end to end", async () => {
  await step("the first run asks before checking for updates", async () => {
    await s.see("Check for updates automatically?");
    // No network in these tests: the app never checks without being asked.
    await s.click('[role="dialog"] button', "Don't check");
  });

  await step("add a SQLite connection and connect", async () => {
    await s.click("button", "New connection");
    await s.click('[role="radio"]', /SQLite$/);
    await s.type("label.field .field-row input.mono", null, db);
    await s.click("button", "Save & connect");
    await s.see("customers");
  });

  await step("run a query", async () => {
    await s.click("button", "New query tab");
    await runSql("SELECT name, city FROM customers ORDER BY id");
    await s.see("Result (3)");
    await s.see("Grace");
  });

  await step("open a table from Ctrl+K", async () => {
    await s.keys(Key.Control, "k");
    await s.type('[role="combobox"]', null, "customers");
    await s.keys(Key.Enter);
    await s.find('[role="tab"][aria-selected="true"]', /customers/);
    await s.find(cell(3, 1), "3");
  });

  await step("edit a cell, review and commit", async () => {
    // Text is loaded on demand in opened tables: Enter loads the value and edits it.
    await s.click(cell(3, 2), null);
    await s.keys(Key.Enter);
    await s.type('input[aria-label="Edit name"]', null, `${Key.Control}a${Key.Control}Linus T.${Key.Enter}`);
    await s.see("1 pending change");
    await s.click("button", "Review and commit");
    await s.click('[role="dialog"] button', "Commit changes");
    await s.click('[role="tab"]', /^Query 1/);
    await runSql("SELECT 'name=' || name FROM customers WHERE id = 3");
    await s.see("name=Linus T.");
  });

  await step("a destructive statement asks first, and keeps a restore point", async () => {
    await s.click("button", "New query tab");
    // A DELETE without WHERE (every row) asks before it runs.
    await runSql("DELETE FROM customers");
    await s.see("Confirm execution");
    await s.click('[role="dialog"] button', "Run anyway");
    await s.see(/3 rows affected/i);
    await s.see("Restore point saved");
    await runSql("SELECT 'n=' || count(*) FROM customers");
    await s.see("n=0");
  });

  await step("the deleted rows come back from the restore point", async () => {
    await s.click("button", /^Restore points · \d+/);
    await s.click("button", /^customers · Delete · 3 rows/);
    await s.click("button", "Restore all");
    await s.click('[role="dialog"] button', /^Restore/);
    await s.see(/Restored/i);
    await s.click("button", "Close restore points");
    await runSql("SELECT 'n=' || count(*) FROM customers");
    await s.see("n=3");
  });

  await step("Explain shows the plan", async () => {
    await runSql("SELECT * FROM customers WHERE city = 'Paris'");
    await s.click("button", "Explain");
    await s.find("h2.results-title", "Plan");
    await s.see(/SCAN|SEARCH/);
  });

});
