import { Icon } from "../../components/Icon";
import { filterToText, type GroupNode } from "./filterModel";

/** The applied filter as read-only chips; clicking one opens the filter editor. */
export function FilterChips({ filter, onEdit }: { filter: GroupNode; onEdit: () => void }) {
  // Disabled conditions, and groups with nothing enabled inside, don't filter anything.
  const active = filter.children.filter((c) => (!("enabled" in c) || c.enabled !== false) && filterToText(c).trim() !== "");
  if (active.length === 0) return null;
  return (
    <div className="filter-chips">
      <Icon name="filter_list" size={14} />
      {filter.negate && <span className="logic">NOT</span>}
      <ul aria-label="Active filters">
        {active.map((c, i) => (
          <li key={i}>
            {i > 0 && <span className="logic">{filter.logic}</span>}
            <button className="chip" aria-label={`Edit filter ${filterToText(c)}`} onClick={onEdit}>
              <span className="mono">{filterToText(c)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
