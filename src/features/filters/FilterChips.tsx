import { Icon } from "../../components/Icon";
import { filterToText, type GroupNode } from "./filterModel";

/** The applied filter as read-only chips; clicking one opens the filter editor. */
export function FilterChips({ filter, onEdit }: { filter: GroupNode; onEdit: () => void }) {
  const active = filter.children.filter((c) => !("enabled" in c) || c.enabled !== false);
  if (active.length === 0) return null;
  return (
    <div className="filter-chips">
      <Icon name="filter_list" size={14} />
      <ul aria-label="Active filters">
        {active.map((c, i) => (
          <li key={i}>
            {i > 0 && <span className="logic">{filter.negate ? "" : filter.logic}</span>}
            <button className="chip" aria-label={`Edit filter ${filterToText(c)}`} onClick={onEdit}>
              <span className="mono">{filterToText(c)}</span>
            </button>
          </li>
        ))}
      </ul>
      {filter.negate && <span className="hint">(negated)</span>}
    </div>
  );
}
