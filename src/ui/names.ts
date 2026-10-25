import { t } from '../i18n';
import type { MatchSettings } from '../core/types';

/** Display names of online people by seat (battle rooms, online duels), set while such a match is shown. */
let onlineNames: (string | null)[] = [];

export function setOnlineNames(names: (string | null)[]) {
  onlineNames = names;
}

/**
 * The name of a seat as shown everywhere (HUD chips, hints, results). A bot type that sits at more
 * than one seat is numbered in seat order, all of its seats ("Охотник 1", "Охотник 2"), so "Победитель:
 * Охотник 2" says which one; a bot type that plays once keeps its plain name.
 */
export function playerName(settings: MatchSettings, slot: number): string {
  const type = settings.players[slot];
  const humans = settings.players.filter((p) => p === 'human').length;
  if (type === 'human') return humans > 1 ? t('playerN', { n: slot + 1 }) : t('you');
  if ((settings.kind === 'battleOnline' || settings.kind === 'duelOnline') && (type === 'online' || type === 'remote')) {
    return onlineNames[slot] || (settings.kind === 'duelOnline' ? t('player_remote') : t('playerN', { n: slot + 1 }));
  }
  const base = t(`player_${type}` as 'player_human');
  if (type === 'online' || type === 'remote') return base;
  const same = settings.players.filter((p) => p === type).length;
  if (same < 2) return base;
  const nth = settings.players.slice(0, slot + 1).filter((p) => p === type).length;
  return `${base} ${nth}`;
}
