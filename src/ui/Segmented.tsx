/**
 * Apple-style segmented control: equal-width segments with a glass "thumb" that
 * slides to the selected one.
 */
import type { ReactNode } from 'react';

export interface SegOption<T extends string | number> {
  value: T;
  label: ReactNode;
  title?: string;
}

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  size = 'md',
  ariaLabel,
}: {
  options: SegOption<T>[];
  value: T;
  onChange: (v: T) => void;
  size?: 'sm' | 'md' | 'lg';
  ariaLabel?: string;
}) {
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div className={`segmented ${size}`} role="radiogroup" aria-label={ariaLabel}>
      <span
        className="segmented-thumb"
        style={{ width: `calc((100% - 4px) / ${options.length})`, transform: `translateX(${index * 100}%)` }}
      />
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          className={o.value === value ? 'segmented-btn active' : 'segmented-btn'}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
