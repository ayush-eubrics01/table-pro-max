import type { ExplainResult } from "../../types/backend";
import { formatDuration } from "../../lib/text";

interface PgNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Alias?: string;
  "Total Cost"?: number;
  "Plan Rows"?: number;
  "Actual Total Time"?: number;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  Filter?: string;
  "Index Cond"?: string;
  "Hash Cond"?: string;
  "Join Type"?: string;
  Plans?: PgNode[];
}

function PgPlanNode({ node, rootCost }: { node: PgNode; rootCost: number }) {
  const cost = node["Total Cost"] ?? 0;
  const target = node["Relation Name"] ? ` on ${node["Relation Name"]}${node.Alias && node.Alias !== node["Relation Name"] ? ` ${node.Alias}` : ""}` : "";
  const cond = node["Index Cond"] ?? node["Hash Cond"] ?? node.Filter;
  return (
    <div className="plan-node">
      <div className="head">
        <strong>
          {node["Join Type"] ? `${node["Join Type"]} ` : ""}
          {node["Node Type"]}
        </strong>
        <span>
          {target}
          {node["Index Name"] ? ` using ${node["Index Name"]}` : ""}
        </span>
      </div>
      <div className="stats">
        cost {cost.toFixed(2)} · est. rows {node["Plan Rows"] ?? "?"}
        {node["Actual Total Time"] !== undefined &&
          ` · actual ${node["Actual Total Time"].toFixed(3)} ms × ${node["Actual Loops"] ?? 1} · rows ${node["Actual Rows"]}`}
      </div>
      {cond && <div className="stats">{cond}</div>}
      {rootCost > 0 && <div className="bar" style={{ width: `${Math.min(100, Math.max(2, (cost / rootCost) * 100))}%` }} aria-hidden />}
      {node.Plans?.map((p, i) => <PgPlanNode key={i} node={p} rootCost={rootCost} />)}
    </div>
  );
}

function SqlitePlan({ result }: { result: ExplainResult }) {
  const rows = result.rows?.rows ?? [];
  type N = { id: string; parent: string; detail: string; children: N[] };
  const nodes = new Map<string, N>();
  const roots: N[] = [];
  for (const r of rows) {
    const [id, parent, , detail] = r.map((c) => (typeof c === "string" ? c : ""));
    nodes.set(id!, { id: id!, parent: parent!, detail: detail!, children: [] });
  }
  for (const n of nodes.values()) {
    const p = nodes.get(n.parent);
    if (p) p.children.push(n);
    else roots.push(n);
  }
  const render = (n: N) => (
    <div className="plan-node" key={n.id}>
      <div className="head">
        <strong>{n.detail}</strong>
      </div>
      {n.children.map(render)}
    </div>
  );
  return <>{roots.map(render)}</>;
}

/** Elements under `op` that belong to it, not to an operator nested inside it. */
function own(op: Element, selector: string): Element[] {
  return Array.from(op.querySelectorAll(selector)).filter((e) => e.parentElement?.closest("RelOp") === op);
}

const unbracket = (s: string | null) => (s ?? "").replace(/^\[|\]$/g, "");

/** One SQL Server plan operator (`RelOp`) and the operators it reads from. */
function MssqlPlanNode({ op, rootCost }: { op: Element; rootCost: number }) {
  const cost = Number(op.getAttribute("EstimatedTotalSubtreeCost") ?? 0);
  const physical = op.getAttribute("PhysicalOp") ?? "?";
  const logical = op.getAttribute("LogicalOp");
  const obj = own(op, "Object")[0];
  const target = obj
    ? ` on ${[obj.getAttribute("Schema"), obj.getAttribute("Table")].filter(Boolean).map(unbracket).join(".")}${obj.getAttribute("Index") ? ` using ${unbracket(obj.getAttribute("Index"))}` : ""}`
    : "";
  const predicate = own(op, "Predicate ScalarOperator, SeekPredicates ScalarOperator, SeekPredicateNew ScalarOperator")[0]?.getAttribute("ScalarString");
  const counters = own(op, "RunTimeInformation > RunTimeCountersPerThread");
  const actual = counters.length
    ? {
        rows: counters.reduce((n, c) => n + Number(c.getAttribute("ActualRows") ?? 0), 0),
        executions: counters.reduce((n, c) => n + Number(c.getAttribute("ActualExecutions") ?? 0), 0),
      }
    : null;
  return (
    <div className="plan-node">
      <div className="head">
        <strong>{physical}</strong>
        <span>
          {logical && logical !== physical ? ` (${logical})` : ""}
          {target}
        </span>
      </div>
      <div className="stats">
        cost {cost.toFixed(4)} · est. rows {op.getAttribute("EstimateRows") ?? "?"}
        {actual && ` · actual rows ${actual.rows} × ${actual.executions}`}
      </div>
      {predicate && <div className="stats">{predicate}</div>}
      {rootCost > 0 && <div className="bar" style={{ width: `${Math.min(100, Math.max(2, (cost / rootCost) * 100))}%` }} aria-hidden />}
      {own(op, "RelOp").map((child, i) => (
        <MssqlPlanNode key={i} op={child} rootCost={rootCost} />
      ))}
    </div>
  );
}

/** SQL Server's showplan XML: each statement's operator tree. */
function MssqlPlan({ raw }: { raw: string }) {
  // The declaration says utf-16, which a JavaScript string no longer is.
  const doc = new DOMParser().parseFromString(raw.replace(/^\s*<\?xml[^>]*\?>/, ""), "application/xml");
  const plans = doc.querySelector("parsererror") ? [] : Array.from(doc.querySelectorAll("QueryPlan"));
  if (plans.length === 0) return <pre className="code-block">{raw}</pre>;
  return (
    <>
      {plans.map((plan, i) => {
        const root = Array.from(plan.querySelectorAll("RelOp")).find((r) => r.parentElement?.closest("RelOp") === null);
        const text = plan.closest("StmtSimple")?.getAttribute("StatementText");
        return (
          <div key={i}>
            {plans.length > 1 && text && <div className="hint mono">{text}</div>}
            {root && <MssqlPlanNode op={root} rootCost={Number(root.getAttribute("EstimatedTotalSubtreeCost") ?? 0)} />}
          </div>
        );
      })}
    </>
  );
}

/** Plans are engine specific; each format is rendered on its own terms. */
export function ExplainView({ result }: { result: ExplainResult }) {
  let body: React.ReactNode;
  if (result.format === "postgres_json") {
    try {
      const parsed = JSON.parse(result.raw) as { Plan: PgNode; "Execution Time"?: number; "Planning Time"?: number }[];
      const top = parsed[0]!;
      body = (
        <>
          {top["Execution Time"] !== undefined && (
            <div className="hint">
              Planning {top["Planning Time"]?.toFixed(3)} ms · execution {top["Execution Time"].toFixed(3)} ms
            </div>
          )}
          <PgPlanNode node={top.Plan} rootCost={top.Plan["Total Cost"] ?? 0} />
        </>
      );
    } catch {
      body = <pre className="code-block">{result.raw}</pre>;
    }
  } else if (result.format === "mssql_xml") {
    body = <MssqlPlan raw={result.raw} />;
  } else if (result.format === "sqlite_plan") {
    body = <SqlitePlan result={result} />;
  } else if (result.format === "mysql_json") {
    let pretty = result.raw;
    try {
      pretty = JSON.stringify(JSON.parse(result.raw), null, 2);
    } catch {
      /* show raw text */
    }
    body = <pre className="code-block">{pretty}</pre>;
  } else {
    body = <pre className="code-block">{result.raw}</pre>;
  }
  return (
    <div className="structure" aria-label="Query plan">
      <div className="hint">Plan retrieved in {formatDuration(result.durationMs)}. Plans are specific to this database engine.</div>
      {body}
    </div>
  );
}
