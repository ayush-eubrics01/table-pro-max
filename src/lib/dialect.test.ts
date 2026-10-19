import { describe, expect, it } from "vitest";
import { databaseToReopen, formatterLanguage, quoteName } from "./dialect";
import { DRIVERS } from "./env";
import { newProfile } from "../stores/connections";
import { queryTarget } from "../features/sql-editor/queryTarget";
import { session } from "../test/fixtures";

describe("dialect helpers", () => {
  it("formats with each database's own SQL", () => {
    expect(formatterLanguage("postgres", "postgres")).toBe("postgresql");
    expect(formatterLanguage("mysql", "mariadb")).toBe("mariadb");
    expect(formatterLanguage("sqlite", "sqlite")).toBe("sqlite");
    expect(formatterLanguage("mssql", "mssql")).toBe("transactsql");
  });

  it("quotes names the way each database does", () => {
    expect(quoteName("postgres", 'a"b')).toBe('"a""b"');
    expect(quoteName("mysql", "a`b")).toBe("`a``b`");
    expect(quoteName("mssql", "a]b")).toBe("[a]]b]");
  });

  it("reopens the open database where a connection serves several", () => {
    const one = { ...session, database: "shop" };
    expect(databaseToReopen({ ...one, capabilities: { ...one.capabilities, multipleDatabases: true } })).toBe("shop");
    expect(databaseToReopen({ ...one, capabilities: { ...one.capabilities, multipleDatabases: false } })).toBeNull();
  });

  it("offers SQL Server with its own port and target", () => {
    expect(DRIVERS.find((d) => d.value === "mssql")?.label).toBe("SQL Server");
    expect(newProfile("mssql").port).toBe(1433);
    expect(newProfile("mssql").passwordMode).toBe("keychain");
    expect(queryTarget("mssql", "mssql", "shop", "dbo")).toBe("shop.dbo");
  });
});
