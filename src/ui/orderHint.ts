import { t } from '../i18n';
import type { OrderComp } from '../core/types';

/** What the turn-order compensation of a match changes, said once at its start (null: nothing to say). */
export function orderCompHint(c: OrderComp | 'off' | undefined): string | null {
  if (!c || c === 'off') return null;
  if (c.skip && c.skip > 1) return t('orderSkipHintMany', { n: c.skip });
  if (c.skip) {
    const b = Math.max(0, ...(c.bonus ?? []).slice(0, c.skip));
    return b > 0 ? t('orderSkipHint', { b }) : t('orderSkipHintPlain');
  }
  if (c.order === 'snake') return t('orderSnakeHint');
  const top = Math.max(0, ...(c.bonus ?? []));
  return top > 0 ? t('orderBonusHint', { b: top }) : null;
}
