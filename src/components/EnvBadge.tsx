import type { Environment } from "../types/backend";
import { envLabel, envStyle } from "../lib/env";

export function EnvBadge({ env }: { env: Environment }) {
  return (
    <span className="env-badge" data-env={env} style={envStyle(env)}>
      {envLabel(env)}
    </span>
  );
}
