/**
 * Inline 16px stroke icons (no icon font / external assets — the plugin UI must
 * be a single self-contained HTML file). All inherit `currentColor`.
 */
import type { ReactNode, SVGProps } from 'react';

function Svg({ children, ...rest }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconCode = () => (
  <Svg>
    <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />
  </Svg>
);
/** Box with an outgoing arrow — "export to code". */
export const IconExport = () => (
  <Svg>
    <path d="M9.5 2.5h4v4M13.5 2.5 8 8M11.5 9.5v3A1.5 1.5 0 0 1 10 14H4a1.5 1.5 0 0 1-1.5-1.5v-6A1.5 1.5 0 0 1 4 5h3" />
  </Svg>
);
export const IconLink = () => (
  <Svg>
    <path d="M6.5 9.5a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.8.8M9.5 6.5a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.8-.8" />
  </Svg>
);
export const IconFile = () => (
  <Svg>
    <path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6L9 2Z" />
    <path d="M9 2v4h4" />
  </Svg>
);
export const IconSparkle = () => (
  <Svg>
    <path d="M8 2.5 9.2 6.8 13.5 8l-4.3 1.2L8 13.5 6.8 9.2 2.5 8l4.3-1.2L8 2.5Z" />
  </Svg>
);
export const IconSettings = () => (
  <Svg>
    <path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6" />
    <circle cx="10" cy="4.5" r="1.5" />
    <circle cx="6" cy="11.5" r="1.5" />
  </Svg>
);
export const IconSend = () => (
  <Svg>
    <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
  </Svg>
);
export const IconStop = () => (
  <Svg fill="currentColor" stroke="none">
    <rect x="4" y="4" width="8" height="8" rx="1.5" />
  </Svg>
);
export const IconBack = () => (
  <Svg>
    <path d="M10 3.5 5.5 8l4.5 4.5" />
  </Svg>
);
export const IconChevron = ({ open }: { open?: boolean }) => (
  <Svg style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform .15s' }}>
    <path d="M6 3.5 10.5 8 6 12.5" />
  </Svg>
);
export const IconClose = () => (
  <Svg>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
);
export const IconCheck = () => (
  <Svg>
    <path d="M3 8.5 6.5 12 13 4.5" />
  </Svg>
);
export const IconEye = () => (
  <Svg>
    <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
    <circle cx="8" cy="8" r="2" />
  </Svg>
);
export const IconUpload = () => (
  <Svg>
    <path d="M8 10.5V2.5M4.5 6 8 2.5 11.5 6M2.5 10.5v2A1.5 1.5 0 0 0 4 14h8a1.5 1.5 0 0 0 1.5-1.5v-2" />
  </Svg>
);
export const IconTool = () => (
  <Svg>
    <path d="M9.8 2.6a3.2 3.2 0 0 0-4 4L2.5 9.9a1.4 1.4 0 0 0 2 2l3.3-3.3a3.2 3.2 0 0 0 4-4L9.9 6.5 8.8 5.4l1.9-1.9-.9-.9Z" />
  </Svg>
);
export const IconPower = () => (
  <Svg>
    <path d="M8 2v5.5M4.6 4.2a5 5 0 1 0 6.8 0" />
  </Svg>
);
/** Diagonal grip for the window resize corner. */
export const IconGrip = () => (
  <Svg strokeWidth="1.2">
    <path d="M14 7 7 14M14 10.5 10.5 14" />
  </Svg>
);
