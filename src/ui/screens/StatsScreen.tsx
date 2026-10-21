import { t } from '../../i18n';
import { navigate, useSettings } from '../store';
import { TopBar } from '../components/controls';
import { loadDaily, loadStats, type GameRecord } from '../../storage';
import { SIZE_ORDER, type PlayerType } from '../../core/types';

function rate(list: GameRecord[]) {
  return list.length ? Math.round((list.filter((r) => r.win).length / list.length) * 100) : 0;
}

export function StatsScreen() {
  useSettings();
  const stats = loadStats();
  const solo = stats.records.filter((r) => r.humans === 1 && r.kind !== 'duelOnline');
  const duels = stats.records.filter((r) => r.kind === 'duelOnline' || r.kind === 'duelTraining');
  const daily = loadDaily();
  const dailyWon = Object.values(daily).filter((d) => d.bestRounds !== null).length;
  const captured = stats.records.reduce((a, r) => a + r.captured, 0);
  const recent = [...stats.records].reverse().slice(0, 12);

  const strongest = (r: GameRecord): PlayerType | null => {
    const order: PlayerType[] = ['master', 'hunter', 'duelHunter', 'dummy', 'freak'];
    return order.find((o) => r.opponents.includes(o)) ?? null;
  };
  const byBot = (['freak', 'dummy', 'hunter', 'master'] as PlayerType[]).map((b) => {
    const list = solo.filter((r) => strongest(r) === b);
    return { b, n: list.length, rate: rate(list) };
  });

  return (
    <div class="screen">
      <div class="screen-inner">
        <TopBar title={t('statsTitle')} onBack={() => navigate({ name: 'menu' })} />
        {stats.records.length === 0 ? (
          <div class="card muted" style={{ textAlign: 'center', padding: 28 }}>
            {t('sNoGames')}
          </div>
        ) : (
          <>
            <div class="big-stats">
              <div>
                <b>{solo.length}</b>
                <span>{t('sGames')}</span>
              </div>
              <div>
                <b style={{ color: 'var(--good)' }}>{rate(solo)}%</b>
                <span>{t('sWinRate')}</span>
              </div>
              <div>
                <b style={{ color: 'var(--warn)' }}>{stats.bestStreak}</b>
                <span>{t('sBestStreak')}</span>
              </div>
            </div>

            <div class="section-title">{t('sVsBots')}</div>
            <div class="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {byBot.map(({ b, n, rate: r }) => (
                <div class="bar-line" key={b}>
                  <span style={{ width: 84 }}>{t(`player_${b}` as 'player_human')}</span>
                  <div class="bar">
                    <div style={{ width: `${r}%` }} />
                  </div>
                  <span class="muted" style={{ width: 70, textAlign: 'right' }}>
                    {n ? `${r}% · ${n}` : '—'}
                  </span>
                </div>
              ))}
            </div>

            <div class="section-title">{t('sBySize')}</div>
            <div class="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {SIZE_ORDER.map((sz) => {
                const list = solo.filter((r) => r.size === sz);
                return (
                  <div class="bar-line" key={sz}>
                    <span style={{ width: 84 }}>{t(`size${sz}` as 'sizeS')}</span>
                    <div class="bar">
                      <div style={{ width: `${rate(list)}%` }} />
                    </div>
                    <span class="muted" style={{ width: 70, textAlign: 'right' }}>
                      {list.length ? `${rate(list)}% · ${list.length}` : '—'}
                    </span>
                  </div>
                );
              })}
            </div>

            <div class="big-stats">
              <div>
                <b>{duels.length ? `${rate(duels)}%` : '—'}</b>
                <span>
                  {t('sDuels')} · {duels.length}
                </span>
              </div>
              <div>
                <b>{dailyWon}</b>
                <span>{t('sDaily')}</span>
              </div>
              <div>
                <b>{captured}</b>
                <span>{t('sCaptured')}</span>
              </div>
            </div>

            <div class="section-title">{t('sRecent')}</div>
            <div class="list">
              {recent.map((r, i) => (
                <div class="list-item" key={i} style={{ minHeight: 48 }}>
                  <span style={{ color: r.humans > 1 ? 'var(--muted)' : r.win ? 'var(--good)' : 'var(--bad)', fontWeight: 800, width: 22 }}>
                    {r.humans > 1 ? '•' : r.win ? 'W' : 'L'}
                  </span>
                  <div class="grow">
                    <div style={{ fontSize: 14, fontWeight: 600 }}>
                      {r.kind === 'daily' ? t('daily') : r.kind.startsWith('duel') ? t('duels') : t(`size${r.size}` as 'sizeS')} ·{' '}
                      {r.opponents.map((o) => t(`player_${o}` as 'player_human')).join(', ')}
                    </div>
                    <div class="desc">
                      {new Date(r.at).toLocaleDateString()} · {t('round', { n: r.rounds })}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
