import { useEffect, useRef, useState } from "react";
import { compact, niceTicks, shortLabel, type Dataset, type Slice } from "./chartData";

const HEIGHT = 220;
const PAD = { top: 12, right: 16, bottom: 26, left: 44 };
const color = (i: number) => `var(--series-${(i % 8) + 1})`;

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(480);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(Math.max(200, el.clientWidth || 480));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

export function Legend({ names }: { names: string[] }) {
  if (names.length < 2) return null;
  return (
    <div className="chart-legend" role="list">
      {names.map((n, i) => (
        <span key={n} role="listitem">
          <i style={{ background: color(i) }} aria-hidden />
          {n}
        </span>
      ))}
    </div>
  );
}

function Tooltip({ x, y, title, rows, width }: { x: number; y: number; title: string; rows: { name: string; value: string; i: number }[]; width: number }) {
  const left = Math.min(Math.max(8, x + 12), width - 180);
  return (
    <div className="chart-tooltip" style={{ left, top: Math.max(0, y - 10) }} role="tooltip">
      <div className="chart-tooltip-title">{title}</div>
      {rows.map((r) => (
        <div key={r.name} className="chart-tooltip-row">
          <i style={{ background: color(r.i) }} aria-hidden />
          <span>{r.name}</span>
          <strong>{r.value}</strong>
        </div>
      ))}
    </div>
  );
}

function yScale(data: Dataset, plotH: number) {
  const all = data.series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all));
  const lo = ticks[0]!;
  const hi = ticks[ticks.length - 1]!;
  const y = (v: number) => PAD.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
  return { ticks, y };
}

function Axes({ ticks, y, width, labels, xAt }: { ticks: number[]; y: (v: number) => number; width: number; labels: string[]; xAt: (i: number) => number }) {
  const every = Math.max(1, Math.ceil(labels.length / Math.max(2, Math.floor((width - PAD.left) / 90))));
  return (
    <g className="chart-axes">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} className="chart-grid" />
          <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end">
            {compact(t)}
          </text>
        </g>
      ))}
      {labels.map((l, i) =>
        i % every === 0 ? (
          <text key={i} x={xAt(i)} y={HEIGHT - 8} textAnchor="middle">
            {shortLabel(l)}
          </text>
        ) : null,
      )}
    </g>
  );
}

export function LineChart({ data }: { data: Dataset }) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const n = data.x.length;
  const xAt = (i: number) => PAD.left + (n <= 1 ? 0 : (i / (n - 1)) * (width - PAD.left - PAD.right));
  const { ticks, y } = yScale(data, plotH);
  const single = data.series.length === 1;

  const path = (values: (number | null)[]) => {
    let d = "";
    let pen = false;
    values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${xAt(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - box.left) / (box.width || 1);
    setHover(Math.max(0, Math.min(n - 1, Math.round(rel * (n - 1)))));
  };

  const last = n - 1;
  return (
    <div ref={ref} className="chart">
      <svg width={width} height={HEIGHT} role="img" aria-label={`Line chart of ${data.series.map((s) => s.name).join(", ")}`}>
        <Axes ticks={ticks} y={y} width={width} labels={data.x} xAt={xAt} />
        {single && (
          <path
            d={`${path(data.series[0]!.values)}L${xAt(last)},${y(ticks[0]!)}L${xAt(0)},${y(ticks[0]!)}Z`}
            fill={color(0)}
            opacity={0.1}
          />
        )}
        {data.series.map((s, i) => (
          <path key={s.name} d={path(s.values)} fill="none" stroke={color(i)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {data.series.map((s, i) => {
          const v = s.values[last];
          return v === null || v === undefined ? null : (
            <circle key={s.name} cx={xAt(last)} cy={y(v)} r={4} fill={color(i)} stroke="var(--surface)" strokeWidth={2} />
          );
        })}
        {hover !== null && (
          <g pointerEvents="none">
            <line x1={xAt(hover)} x2={xAt(hover)} y1={PAD.top} y2={PAD.top + plotH} className="chart-crosshair" />
            {data.series.map((s, i) => {
              const v = s.values[hover];
              return v === null || v === undefined ? null : (
                <circle key={s.name} cx={xAt(hover)} cy={y(v)} r={4} fill={color(i)} stroke="var(--surface)" strokeWidth={2} />
              );
            })}
          </g>
        )}
        <rect
          x={PAD.left}
          y={PAD.top}
          width={Math.max(1, width - PAD.left - PAD.right)}
          height={plotH}
          fill="transparent"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        />
      </svg>
      {hover !== null && (
        <Tooltip
          x={xAt(hover)}
          y={PAD.top}
          width={width}
          title={data.x[hover] ?? ""}
          rows={data.series.map((s, i) => ({ name: s.name, value: s.values[hover] === null ? "—" : compact(s.values[hover]!), i }))}
        />
      )}
      <Legend names={data.series.map((s) => s.name)} />
    </div>
  );
}

export function BarChart({ data }: { data: Dataset }) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const n = Math.max(1, data.x.length);
  const band = (width - PAD.left - PAD.right) / n;
  const xAt = (i: number) => PAD.left + band * (i + 0.5);
  const { ticks, y } = yScale(data, plotH);
  const k = data.series.length;
  const GAP = 2;
  const barW = Math.max(2, Math.min(24, (band * 0.8 - GAP * (k - 1)) / k));
  const base = y(Math.max(ticks[0]!, Math.min(0, ticks[ticks.length - 1]!)));

  // Rounded data-end (4px), square at the baseline.
  const bar = (x: number, v: number) => {
    const top = y(v);
    const h = Math.abs(base - top);
    const r = Math.min(4, h, barW / 2);
    if (v >= 0) return `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + barW - r}Q${x + barW},${top} ${x + barW},${top + r}V${base}Z`;
    return `M${x},${base}V${top - r}Q${x},${top} ${x + r},${top}H${x + barW - r}Q${x + barW},${top} ${x + barW},${top - r}V${base}Z`;
  };

  return (
    <div ref={ref} className="chart">
      <svg width={width} height={HEIGHT} role="img" aria-label={`Bar chart of ${data.series.map((s) => s.name).join(", ")}`}>
        <Axes ticks={ticks} y={y} width={width} labels={data.x} xAt={xAt} />
        {data.x.map((_, i) => {
          const groupW = k * barW + (k - 1) * GAP;
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={xAt(i) - band / 2} y={PAD.top} width={band} height={plotH} fill="transparent" />
              {data.series.map((s, j) => {
                const v = s.values[i];
                if (v === null || v === undefined) return null;
                return <path key={s.name} d={bar(xAt(i) - groupW / 2 + j * (barW + GAP), v)} fill={color(j)} opacity={hover === null || hover === i ? 1 : 0.55} />;
              })}
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <Tooltip
          x={xAt(hover)}
          y={PAD.top}
          width={width}
          title={data.x[hover] ?? ""}
          rows={data.series.map((s, i) => ({ name: s.name, value: s.values[hover] === null ? "—" : compact(s.values[hover]!), i }))}
        />
      )}
      <Legend names={data.series.map((s) => s.name)} />
    </div>
  );
}

export function DonutChart({ slices }: { slices: Slice[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;
  const R = 80;
  const r = 52;
  const c = 90;
  let angle = -Math.PI / 2;
  const arcs = slices.map((s, i) => {
    const a0 = angle;
    const a1 = angle + (s.value / total) * Math.PI * 2;
    angle = a1;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad: number, a: number) => `${c + rad * Math.cos(a)},${c + rad * Math.sin(a)}`;
    const d =
      slices.length === 1
        ? `M${c - R},${c}A${R},${R} 0 1 1 ${c + R},${c}A${R},${R} 0 1 1 ${c - R},${c}M${c - r},${c}A${r},${r} 0 1 0 ${c + r},${c}A${r},${r} 0 1 0 ${c - r},${c}Z`
        : `M${p(R, a0)}A${R},${R} 0 ${large} 1 ${p(R, a1)}L${p(r, a1)}A${r},${r} 0 ${large} 0 ${p(r, a0)}Z`;
    return { d, i, s };
  });
  return (
    <div className="chart chart-donut">
      <svg width={180} height={180} role="img" aria-label="Share chart" fillRule="evenodd">
        {arcs.map(({ d, i, s }) => (
          // The 2px surface-colored stroke is the gap between neighbouring slices.
          <path
            key={s.label}
            d={d}
            fill={color(i)}
            stroke="var(--surface)"
            strokeWidth={2}
            opacity={hover === null || hover === i ? 1 : 0.55}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
        <text x={c} y={c} textAnchor="middle" dy="0.32em" className="chart-donut-total">
          {compact(total)}
        </text>
      </svg>
      <div className="chart-legend chart-legend-col" role="list">
        {slices.map((s, i) => (
          <span key={s.label} role="listitem" className={hover === i ? "active" : undefined}>
            <i style={{ background: color(i) }} aria-hidden />
            {s.label}
            <strong>
              {compact(s.value)} · {((s.value / total) * 100).toFixed(1)}%
            </strong>
          </span>
        ))}
      </div>
    </div>
  );
}

export function Kpi({ value, previous }: { value: number | null; previous: number | null }) {
  const delta = value !== null && previous !== null && previous !== 0 ? ((value - previous) / Math.abs(previous)) * 100 : null;
  return (
    <div className="kpi">
      <div className="kpi-value">{value === null ? "—" : compact(value)}</div>
      {delta !== null && (
        <div className="kpi-delta">
          {delta >= 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(1)}% vs previous ({compact(previous!)})
        </div>
      )}
    </div>
  );
}
