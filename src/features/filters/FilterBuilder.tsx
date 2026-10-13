import { useEffect, useState } from "react";
import { Plus, Trash2, Braces, Code } from "lucide-react";
import type { ColumnInfo, FilterNode, FilterPreset } from "../../types/backend";
import { api } from "../../lib/ipc";
import { uid } from "../../lib/text";
import { notifyError, promptText } from "../../stores/ui";
import {
  OPS,
  countConditions,
  defaultOp,
  emptyGroup,
  filterToText,
  formatList,
  newCondition,
  opInfo,
  opsForType,
  parseList,
  placeholderFor,
  updateAt,
  type GroupNode,
} from "./filterModel";

interface Props {
  columns: ColumnInfo[];
  value: GroupNode;
  onChange: (g: GroupNode) => void;
  onApply: (g: GroupNode) => void;
  connectionId: string;
  schema: string;
  table: string;
}

export function FilterBuilder({ columns, value, onChange, onApply, connectionId, schema, table }: Props) {
  const [presets, setPresets] = useState<FilterPreset[]>([]);

  useEffect(() => {
    api.listFilterPresets(connectionId, schema, table).then(setPresets).catch(() => setPresets([]));
  }, [connectionId, schema, table]);

  const savePreset = async () => {
    const name = await promptText({ title: "Save filter preset", label: "Preset name" });
    if (!name?.trim()) return;
    const preset: FilterPreset = {
      id: uid(),
      connectionId,
      schemaName: schema,
      tableName: table,
      name: name.trim(),
      filter: value,
    };
    try {
      await api.saveFilterPreset(preset);
      setPresets(await api.listFilterPresets(connectionId, schema, table));
    } catch (e) {
      notifyError(e, "Preset was not saved");
    }
  };

  const preview = filterToText(value);

  return (
    <div
      className="filters"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
          e.preventDefault();
          onApply(value);
        }
      }}
    >
      <GroupEditor group={value} path={[]} root={value} columns={columns} onChange={onChange} isRoot />
      <div className="filter-row">
        <button className="btn btn-primary" onClick={() => onApply(value)}>
          Apply filters
        </button>
        <button
          className="btn"
          onClick={() => {
            const g = emptyGroup();
            onChange(g);
            onApply(g);
          }}
          disabled={value.children.length === 0}
        >
          Clear
        </button>
        <span className="hint">{countConditions(value)} active</span>
        <span style={{ flex: 1 }} />
        {presets.length > 0 && (
          <select
            className="select"
            aria-label="Load filter preset"
            value=""
            onChange={(e) => {
              const p = presets.find((x) => x.id === e.target.value);
              if (p && p.filter.type === "group") {
                onChange(p.filter);
                onApply(p.filter);
              }
            }}
          >
            <option value="">Presets…</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <button className="btn" onClick={savePreset} disabled={value.children.length === 0}>
          Save preset
        </button>
      </div>
      {preview && <div className="filter-sql">WHERE {preview}</div>}
    </div>
  );
}

function GroupEditor({
  group,
  path,
  root,
  columns,
  onChange,
  isRoot,
}: {
  group: GroupNode;
  path: number[];
  root: GroupNode;
  columns: ColumnInfo[];
  onChange: (g: GroupNode) => void;
  isRoot?: boolean;
}) {
  const update = (f: (n: FilterNode) => FilterNode | null) => onChange(updateAt(root, path, f));
  const add = (node: FilterNode) => update((n) => ({ ...(n as GroupNode), children: [...(n as GroupNode).children, node] }));
  const firstCol = columns[0];

  return (
    <div className={`filter-group ${isRoot ? "root" : ""}`}>
      <div className="filter-row">
        <div className="segmented" role="group" aria-label="Combine conditions with">
          {(["and", "or"] as const).map((l) => (
            <button key={l} aria-pressed={group.logic === l} onClick={() => update((n) => ({ ...(n as GroupNode), logic: l }))}>
              {l === "and" ? "All of" : "Any of"}
            </button>
          ))}
        </div>
        <label className="checkbox hint">
          <input
            type="checkbox"
            checked={!!group.negate}
            onChange={(e) => update((n) => ({ ...(n as GroupNode), negate: e.target.checked }))}
          />
          Negate
        </label>
        {firstCol && (
          <button className="btn btn-ghost" onClick={() => add(newCondition(firstCol))}>
            <Plus size={14} /> Condition
          </button>
        )}
        <button className="btn btn-ghost" onClick={() => add(emptyGroup())}>
          <Braces size={14} /> Group
        </button>
        <button className="btn btn-ghost" onClick={() => add({ type: "raw", sql: "", enabled: true })}>
          <Code size={14} /> SQL
        </button>
        {!isRoot && (
          <button className="btn btn-ghost btn-icon" aria-label="Remove group" onClick={() => update(() => null)}>
            <Trash2 size={14} />
          </button>
        )}
      </div>
      {group.children.map((child, i) =>
        child.type === "group" ? (
          <GroupEditor key={i} group={child} path={[...path, i]} root={root} columns={columns} onChange={onChange} />
        ) : child.type === "raw" ? (
          <div key={i} className="filter-row">
            <input
              type="checkbox"
              aria-label="Enable condition"
              checked={child.enabled !== false}
              onChange={(e) => onChange(updateAt(root, [...path, i], (n) => ({ ...n, enabled: e.target.checked }) as FilterNode))}
            />
            <input
              className="input mono"
              style={{ maxWidth: "none" }}
              placeholder="SQL condition, e.g. created_at > now() - interval '1 day'"
              aria-label="SQL condition"
              value={child.sql}
              onChange={(e) => onChange(updateAt(root, [...path, i], (n) => ({ ...n, sql: e.target.value }) as FilterNode))}
            />
            <button
              className="btn btn-ghost btn-icon"
              aria-label="Remove condition"
              onClick={() => onChange(updateAt(root, [...path, i], () => null))}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ) : (
          <ConditionEditor
            key={i}
            node={child}
            columns={columns}
            onChange={(n) => onChange(updateAt(root, [...path, i], () => n))}
          />
        ),
      )}
    </div>
  );
}

function ConditionEditor({
  node,
  columns,
  onChange,
}: {
  node: Extract<FilterNode, { type: "condition" }>;
  columns: ColumnInfo[];
  onChange: (n: FilterNode | null) => void;
}) {
  const column = columns.find((c) => c.name === node.column);
  const type = column?.dataType ?? "";
  const allowed = opsForType(type);
  const arity = opInfo(node.op).arity;
  const [listText, setListText] = useState(formatList(node.values ?? []));

  // Keep the model consistent with what the operator dropdown can show.
  const invalidOp = column !== undefined && !allowed.includes(node.op);
  useEffect(() => {
    if (invalidOp) onChange({ ...node, op: defaultOp(type) });
  }, [invalidOp, node, onChange, type]);

  return (
    <div className="filter-row">
      <input
        type="checkbox"
        aria-label="Enable condition"
        checked={node.enabled !== false}
        onChange={(e) => onChange({ ...node, enabled: e.target.checked })}
      />
      <select
        className="select"
        aria-label="Column"
        value={node.column}
        onChange={(e) => {
          const c = columns.find((x) => x.name === e.target.value);
          const ops = opsForType(c?.dataType ?? "");
          onChange({ ...node, column: e.target.value, op: ops.includes(node.op) ? node.op : defaultOp(c?.dataType ?? "") });
        }}
      >
        {columns.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name}
          </option>
        ))}
      </select>
      <select
        className="select"
        aria-label="Operator"
        value={node.op}
        onChange={(e) => onChange({ ...node, op: e.target.value as typeof node.op })}
      >
        {OPS.filter((o) => allowed.includes(o.op)).map((o) => (
          <option key={o.op} value={o.op}>
            {o.label}
          </option>
        ))}
      </select>
      {arity === 1 && (
        <input
          className="input"
          aria-label="Value"
          placeholder={placeholderFor(type)}
          value={node.value ?? ""}
          onChange={(e) => onChange({ ...node, value: e.target.value })}
        />
      )}
      {arity === 2 && (
        <>
          <input
            className="input"
            aria-label="From"
            placeholder={placeholderFor(type)}
            value={node.value ?? ""}
            onChange={(e) => onChange({ ...node, value: e.target.value })}
          />
          <span className="hint">and</span>
          <input
            className="input"
            aria-label="To"
            placeholder={placeholderFor(type)}
            value={node.value2 ?? ""}
            onChange={(e) => onChange({ ...node, value2: e.target.value })}
          />
        </>
      )}
      {arity === "list" && (
        <input
          className="input"
          aria-label="Values, comma separated"
          placeholder="a, b, c"
          value={listText}
          onChange={(e) => {
            setListText(e.target.value);
            onChange({ ...node, values: parseList(e.target.value) });
          }}
        />
      )}
      <button className="btn btn-ghost btn-icon" aria-label="Remove condition" onClick={() => onChange(null)}>
        <Trash2 size={14} />
      </button>
    </div>
  );
}
