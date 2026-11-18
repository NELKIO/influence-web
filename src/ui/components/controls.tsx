import type { ComponentChildren } from 'preact';
import { sfx } from '../../audio/sfx';
import { IconBack } from './icons';
import { t } from '../../i18n';

export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button
      class={`toggle ${on ? 'on' : ''}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        sfx.click();
        onChange(!on);
      }}
    />
  );
}

/** A range slider in the setting-list style: a title, the value on the right, and the track underneath. */
export function Slider({
  title,
  value,
  min,
  max,
  onChange,
  valueText,
  hint,
}: {
  title: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  /** what the value reads as, for the badge and screen readers */
  valueText?: string;
  hint?: string;
}) {
  const span = Math.max(1, max - min);
  return (
    <label class="list-item slider-row">
      <div class="slider-head">
        <span class="title">{title}</span>
        <span class="slider-value">{valueText ?? value}</span>
      </div>
      <input
        type="range"
        class="slider"
        min={min}
        max={max}
        step={1}
        value={value}
        disabled={min === max}
        aria-valuetext={valueText ?? String(value)}
        style={{ '--fill': `${((value - min) / span) * 100}%` }}
        onInput={(e) => {
          const v = Number((e.currentTarget as HTMLInputElement).value);
          if (v !== value) {
            sfx.click();
            onChange(v);
          }
        }}
      />
      <div class="slider-scale" aria-hidden="true">
        <span>{min}</span>
        {hint && <span class="slider-hint">{hint}</span>}
        <span>{max}</span>
      </div>
    </label>
  );
}

export function Seg<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  /** accessible name of the group */
  label?: string;
}) {
  return (
    <div class="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          class={o.value === value ? 'on' : ''}
          role="radio"
          aria-checked={o.value === value}
          onClick={() => {
            sfx.click();
            onChange(o.value);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function TopBar({ title, onBack, right }: { title: string; onBack?: () => void; right?: ComponentChildren }) {
  return (
    <div class="topbar">
      {onBack && (
        <button
          class="icon-btn"
          aria-label={t('back')}
          onClick={() => {
            sfx.click();
            onBack();
          }}
        >
          <IconBack />
        </button>
      )}
      <h1>{title}</h1>
      {right}
    </div>
  );
}

export function Modal({ children, onBackdrop, solid }: { children: ComponentChildren; onBackdrop?: () => void; solid?: boolean }) {
  return (
    <div
      class={`overlay ${solid ? 'solid' : ''}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onBackdrop?.();
      }}
    >
      <div class="modal">{children}</div>
    </div>
  );
}

export function SettingRow({ title, desc, children }: { title: string; desc?: string; children: ComponentChildren }) {
  return (
    <div class="list-item">
      <div class="grow">
        <div class="title">{title}</div>
        {desc && <div class="desc">{desc}</div>}
      </div>
      {children}
    </div>
  );
}
