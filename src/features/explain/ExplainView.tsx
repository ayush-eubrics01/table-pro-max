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
