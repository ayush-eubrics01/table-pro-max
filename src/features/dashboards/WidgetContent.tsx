import type { Cell, ColumnMeta, WidgetDef } from "../../types/backend";
import { DataGrid } from "../data-grid/DataGrid";
import { BarChart, DonutChart, Kpi, LineChart } from "./Charts";
import { toDataset, toNumber, toSlices } from "./chartData";

export function WidgetContent({ type, asTable, columns, rows }: { type: WidgetDef["type"]; asTable: boolean; columns: ColumnMeta[]; rows: Cell[][] }) {
  if (asTable) {
    return (
      <div style={{ height: 240, display: "flex", flexDirection: "column" }}>
        <DataGrid ariaLabel="Widget data" columns={columns.map((c) => ({ name: c.name, typeName: c.typeName }))} rowCount={rows.length} getRow={(i) => rows[i]} />
      </div>
    );
  }
  if (rows.length === 0) return <p className="hint">The query returned no rows.</p>;
  if (type === "kpi") {
    const first = rows[0]!;
    const valueCol = first.findIndex((c) => toNumber(c) !== null);
    const value = valueCol >= 0 ? toNumber(first[valueCol]) : null;
    const previous = valueCol >= 0 ? toNumber(first[valueCol + 1]) : null;
    return <Kpi value={value} previous={previous} />;
  }
  if (type === "pie") {
    const slices = toSlices(columns, rows);
    return slices.length ? <DonutChart slices={slices} /> : <p className="hint">Needs a label column and a positive numeric column.</p>;
  }
  const data = toDataset(columns, rows);
  if (data.series.length === 0) return <p className="hint">Needs a label column followed by at least one numeric column.</p>;
  return type === "line" ? <LineChart data={data} /> : <BarChart data={data} />;
}

