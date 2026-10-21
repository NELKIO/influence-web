import type { ComponentChildren } from 'preact';
import { sfx } from '../../audio/sfx';
import { IconBack } from './icons';

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      class={`toggle ${on ? 'on' : ''}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => {
        sfx.click();
        onChange(!on);
      }}
    />
  );
}

export function Seg<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div class="seg" role="radiogroup">
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
          aria-label="back"
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
