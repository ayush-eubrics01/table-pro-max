import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ExplainView } from "./ExplainView";

afterEach(cleanup);

const showplan = (actual: boolean) => `<?xml version="1.0" encoding="utf-16"?>
<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan" Version="1.6">
  <BatchSequence><Batch><Statements>
    <StmtSimple StatementText="SELECT * FROM items WHERE price &gt; 1" StatementType="SELECT">
      <QueryPlan>
        <RelOp NodeId="0" PhysicalOp="Nested Loops" LogicalOp="Inner Join" EstimateRows="12" EstimatedTotalSubtreeCost="0.0123">
          ${actual ? '<RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="10" ActualExecutions="1" ActualElapsedms="3" /></RunTimeInformation>' : ""}
          <NestedLoops>
            <RelOp NodeId="1" PhysicalOp="Clustered Index Scan" LogicalOp="Clustered Index Scan" EstimateRows="12" EstimatedTotalSubtreeCost="0.0034">
              ${actual ? '<RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="10" ActualExecutions="1" /></RunTimeInformation>' : ""}
              <IndexScan>
                <Object Database="[app]" Schema="[dbo]" Table="[items]" Index="[PK_items]" />
                <Predicate><ScalarOperator ScalarString="[app].[dbo].[items].[price]&gt;(1)" /></Predicate>
              </IndexScan>
            </RelOp>
            <RelOp NodeId="2" PhysicalOp="Index Seek" LogicalOp="Index Seek" EstimateRows="1" EstimatedTotalSubtreeCost="0.0031">
              <IndexScan><Object Database="[app]" Schema="[dbo]" Table="[owners]" Index="[PK_owners]" /></IndexScan>
            </RelOp>
          </NestedLoops>
        </RelOp>
      </QueryPlan>
    </StmtSimple>
  </Statements></Batch></BatchSequence>
</ShowPlanXML>`;

describe("ExplainView: SQL Server plans", () => {
  it("draws the operators as a tree with their objects, estimates and costs", () => {
    render(<ExplainView result={{ format: "mssql_xml", raw: showplan(false), rows: null, durationMs: 4 }} />);
    const plan = screen.getByLabelText("Query plan");
    const root = within(plan).getByText("Nested Loops").closest(".plan-node") as HTMLElement;
    expect(root).toHaveTextContent("Inner Join");
    expect(root).toHaveTextContent("est. rows 12");
    const scan = within(root).getByText("Clustered Index Scan").closest(".plan-node") as HTMLElement;
    expect(scan.parentElement?.closest(".plan-node")).toBe(root);
    expect(scan).toHaveTextContent("on dbo.items using PK_items");
    expect(scan).toHaveTextContent("[app].[dbo].[items].[price]>(1)");
    expect(within(root).getByText("Index Seek").closest(".plan-node")).toHaveTextContent("on dbo.owners");
    expect(plan).not.toHaveTextContent("actual");
  });

  it("shows actual rows for an actual plan", () => {
    render(<ExplainView result={{ format: "mssql_xml", raw: showplan(true), rows: null, durationMs: 4 }} />);
    expect(screen.getByText("Nested Loops").closest(".plan-node")).toHaveTextContent("actual rows 10 × 1");
  });

  it("falls back to the XML when it can't be read", () => {
    render(<ExplainView result={{ format: "mssql_xml", raw: "<not xml", rows: null, durationMs: 1 }} />);
    expect(screen.getByText("<not xml")).toBeInTheDocument();
  });
});
