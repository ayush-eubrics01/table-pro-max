import type { Environment } from "../types/backend";
import { envColorVar, envLabel } from "../lib/env";

export function EnvBadge({ env }: { env: Environment }) {
  return (
    <span className="env-badge" data-env={env} style={{ ["--env-color" as string]: envColorVar(env) }}>
      {envLabel(env)}
    </span>
  );
}
