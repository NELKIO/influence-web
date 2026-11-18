import { t } from '../i18n';
import { orderBonusNow } from '../core/engine';
import type { MatchState, OrderComp } from '../core/types';

/**
 * What the turn-order compensation of a match changes, said once at its start (null: nothing to say).
 * `start`: the match's first position; when some seat's cells cannot hold its whole bonus there, the
 * hint names no number (the scoreboard shows what each seat gets, growing with the cells it takes).
 */
export function orderCompHint(c: OrderComp | 'off' | undefined, start?: MatchState): string | null {
  if (!c || c === 'off') return null;
  if (c.skip && c.skip > 1) return t('orderSkipHintMany', { n: c.skip });
  if (c.skip) {
    const b = Math.max(0, ...(c.bonus ?? []).slice(0, c.skip));
    return b > 0 ? t('orderSkipHint', { b }) : t('orderSkipHintPlain');
  }
  if (c.order === 'snake') return t('orderSnakeHint');
  const bonus = c.bonus ?? [];
  const top = Math.max(0, ...bonus);
  if (top <= 0) return null;
  const cramped = !!start && start.turn === 0 && bonus.some((b, i) => b > orderBonusNow(start, i));
  return cramped ? t('orderBonusHintRoom') : t('orderBonusHint', { b: top });
}
