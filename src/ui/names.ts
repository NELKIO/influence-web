import { t } from '../i18n';
import type { MatchSettings } from '../core/types';

/** Display names of online people by seat (battle rooms), set while such a match is shown. */
let onlineNames: (string | null)[] = [];

export function setOnlineNames(names: (string | null)[]) {
  onlineNames = names;
}

export function playerName(settings: MatchSettings, slot: number): string {
  const type = settings.players[slot];
  const humans = settings.players.filter((p) => p === 'human').length;
  if (type === 'human') return humans > 1 ? t('playerN', { n: slot + 1 }) : t('you');
  if (settings.kind === 'battleOnline' && (type === 'online' || type === 'remote')) {
    return onlineNames[slot] || t('playerN', { n: slot + 1 });
  }
  return t(`player_${type}` as 'player_human');
}
