import { t } from '../i18n';
import type { MatchSettings } from '../core/types';

export function playerName(settings: MatchSettings, slot: number): string {
  const type = settings.players[slot];
  const humans = settings.players.filter((p) => p === 'human').length;
  if (type === 'human') return humans > 1 ? t('playerN', { n: slot + 1 }) : t('you');
  return t(`player_${type}` as 'player_human');
}
