import type { CSSProperties } from "react";
import { ICON_PATHS, type IconName } from "./icons.generated";

export type { IconName };

interface IconProps {
  name: IconName;
  size?: number;
  /** Fill colour; defaults to the surrounding text colour. */
  color?: string;
  className?: string;
  style?: CSSProperties;
  /** Accessible name. Without it the icon is decorative and hidden from screen readers. */
  label?: string;
}

/** Material Symbols Rounded (weight 300), bundled at build time; see scripts/gen-icons.mjs. */
export function Icon({ name, size = 16, color, className, style, label }: IconProps) {
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true as const, focusable: false as const };
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 -960 960 960"
      fill={color ?? "currentColor"}
      style={style}
      {...a11y}
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
