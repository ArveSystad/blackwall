import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/utils";

/** 16-unit stroke icons from the design export. Decorative unless given a label. */
type IconProps = Omit<ComponentProps<"svg">, "children"> & { size?: "sm" | "md" | "lg" };

const SIZES = { sm: "size-3", md: "size-3.5", lg: "size-4" } as const;

function icon(paths: ReactNode) {
  return function Icon({ className, size = "md", ...props }: IconProps) {
    return (
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className={cn(
          "flex-none fill-none stroke-current stroke-[1.5] [stroke-linecap:round] [stroke-linejoin:round]",
          SIZES[size],
          className,
        )}
        {...props}
      >
        {paths}
      </svg>
    );
  };
}

export const WallIcon = icon(
  <>
    <path d="M2 3h12M2 6.5h12M2 10h12M2 13.5h12" />
    <path d="M5 3v3.5M10 6.5V10M5 10v3.5" />
  </>,
);

export const GearIcon = icon(
  <>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
  </>,
);

export const SunIcon = icon(
  <>
    <circle cx="8" cy="8" r="2.8" />
    <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06M3.4 12.6l1.06-1.06M11.54 4.46l1.06-1.06" />
  </>,
);

export const MoonIcon = icon(<path d="M13.5 9.6A5.6 5.6 0 0 1 6.4 2.5a5.6 5.6 0 1 0 7.1 7.1Z" />);

export const SearchIcon = icon(
  <>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5 14 14" />
  </>,
);

export const BackIcon = icon(<path d="M10 4 6 8l4 4" />);

export const CheckIcon = icon(<path d="m3.5 8.5 3 3 6-7" />);

export const WarnIcon = icon(
  <>
    <path d="M8 2 14 13H2Z" />
    <path d="M8 6.5v3M8 11.5v.01" />
  </>,
);

export const JiraIcon = icon(
  <>
    <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
    <path d="M5.5 6h5M5.5 8.5h5M5.5 11h3" />
  </>,
);

export const PullRequestIcon = icon(
  <>
    <circle cx="4.5" cy="3.5" r="1.5" />
    <circle cx="4.5" cy="12.5" r="1.5" />
    <circle cx="11.5" cy="12.5" r="1.5" />
    <path d="M4.5 5v6M11.5 11V7a2.5 2.5 0 0 0-2.5-2.5H7M8.5 3 7 4.5 8.5 6" />
  </>,
);

export const TextIcon = icon(<path d="M3 4h10M3 8h10M3 12h6" />);

export const RepoIcon = icon(
  <>
    <path d="M3 2.5h8.5v11H3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z" />
    <path d="M5 2.5v11" />
  </>,
);

export const BranchIcon = icon(
  <>
    <circle cx="4.5" cy="3.5" r="1.5" />
    <circle cx="4.5" cy="12.5" r="1.5" />
    <circle cx="11.5" cy="5.5" r="1.5" />
    <path d="M4.5 5v6M11.5 7c0 3-7 2-7 4" />
  </>,
);

export const KeyIcon = icon(
  <>
    <circle cx="5.5" cy="10.5" r="3" />
    <path d="m7.6 8.4 5.9-5.9M11.5 4.5l1.5 1.5M10 6l1.2 1.2" />
  </>,
);

export const EyeIcon = icon(
  <>
    <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
    <circle cx="8" cy="8" r="2" />
  </>,
);

export const EyeOffIcon = icon(
  <>
    <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
    <circle cx="8" cy="8" r="2" />
    <path d="m2.5 2.5 11 11" />
  </>,
);

/** Gate: Critical and High findings block the review loop. */
export const LockIcon = icon(
  <>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
  </>,
);

export const ChevronRightIcon = icon(<path d="m6 4 4 4-4 4" />);

export const ChevronDownIcon = icon(<path d="m4 6 4 4 4-4" />);

export const CloseIcon = icon(<path d="m4 4 8 8M12 4l-8 8" />);

export const PlusIcon = icon(<path d="M8 3v10M3 8h10" />);

export const PausedIcon = icon(
  <>
    <circle cx="8" cy="8" r="6" />
    <path d="M6.5 5.5v5M9.5 5.5v5" />
  </>,
);

export const FailedIcon = icon(
  <>
    <circle cx="8" cy="8" r="6" />
    <path d="m6 6 4 4M10 6l-4 4" />
  </>,
);

/** Stop a running task. */
export const StopIcon = icon(
  <>
    <circle cx="8" cy="8" r="6" />
    <rect x="6" y="6" width="4" height="4" rx=".5" />
  </>,
);

/** Delete. */
export const TrashIcon = icon(
  <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4" />,
);

export const PlayIcon = icon(<path d="M5 3.5v9l7-4.5-7-4.5Z" />);

/** Drag handle for reorderable rows. */
export const GripIcon = icon(
  <>
    <circle cx="6" cy="4" r=".6" />
    <circle cx="10" cy="4" r=".6" />
    <circle cx="6" cy="8" r=".6" />
    <circle cx="10" cy="8" r=".6" />
    <circle cx="6" cy="12" r=".6" />
    <circle cx="10" cy="12" r=".6" />
  </>,
);

/** The backlog: stacked items waiting their turn. */
export const BacklogIcon = icon(<path d="M3 4h10M3 8h10M3 12h6M12 11v3M10.5 12.5h3" />);
