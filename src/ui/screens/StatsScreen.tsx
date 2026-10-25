import { getLang, t } from '../../i18n';
import { navigate, useSettings } from '../store';
import { TopBar } from '../components/controls';
import { loadDaily, loadMedals, loadStats, type GameRecord } from '../../storage';
import { SIZE_ORDER, type MatchKind, type PlayerType } from '../../core/types';
import { SCENARIOS } from '../../core/scenarios';
import { Medal } from '../components/Medal';

interface Tally {
  n: number;
  w: number;
}

function tally(list: GameRecord[]): Tally {
  return { n: list.length, w: list.filter((r) => r.win).length };
}

function pct(x: Tally) {
  return x.n ? Math.round((x.w / x.n) * 100) : 0;
}

function BarLine({ label, x }: { label: string; x: Tally }) {
  return (
    <div class="bar-line">
      <span style={{ width: 92, flex: 'none' }}>{label}</span>
      <div class="bar">
        <div style={{ width: `${pct(x)}%` }} />
      </div>
      <span class="muted" style={{ width: 96, textAlign: 'right', flex: 'none', fontSize: 13 }}>
        {x.n ? t('statWinsOf', { w: x.w, n: x.n }) : '—'}
      </span>
    </div>
  );
}

/** Columns of the medal wall: rows of equal length when the count allows it (28 -> 4 rows of 7). */
export function wallColumns(n: number): number {
  return [7, 6, 8, 5].find((c) => n % c === 0 && n >= c) ?? 7;
}

/** Medals of the scenarios in play: how many, how many gold, and every medal (or its empty place). */
function MedalProgress() {
  const medals = loadMedals();
  const got = SCENARIOS.filter((id) => medals[id]).length;
  const gold = SCENARIOS.filter((id) => medals[id]?.tier === 'gold').length;
  const name = (id: (typeof SCENARIOS)[number]) => t(`puzzle_${id}` as 'puzzle_siege');
  return (
    <>
      <div class="section-title">{t('sMedals')}</div>
      <div class="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="medal-progress">
        <div class="bar-line">
          <span style={{ flex: 'none', fontWeight: 700 }}>{t('statMedalsOf', { n: got, total: SCENARIOS.length })}</span>
          <div class="bar">
            <div style={{ width: `${Math.round((got / SCENARIOS.length) * 100)}%` }} />
          </div>
          <span class="muted" style={{ flex: 'none', fontSize: 13 }}>
            {t('statMedalsGold', { n: gold })}
          </span>
        </div>
        <div class="medal-wall" style={{ '--cols': wallColumns(SCENARIOS.length) }}>
          {SCENARIOS.map((id) => (
            <span key={id} title={name(id)}>
              <Medal tier={medals[id]?.tier ?? null} size={26} label={name(id)} />
            </span>
          ))}
        </div>
        <div class="row" style={{ alignItems: 'center' }}>
          <span class="muted grow" style={{ fontSize: 12, lineHeight: 1.4 }}>
            {t('statMedalsHint')}
          </span>
          <button class="btn ghost small" style={{ flex: 'none', width: 'auto' }} onClick={() => navigate({ name: 'setup' })}>
            {t('toScenarios')}
          </button>
        </div>
      </div>
    </>
  );
}

/** Matches against bots with one human: classic battles and daily maps. */
const BATTLE_KINDS: MatchKind[] = ['single', 'daily'];

export function StatsScreen() {
  useSettings();
  const stats = loadStats();
  const records = stats.records;
  const battles = records.filter((r) => r.humans === 1 && BATTLE_KINDS.includes(r.kind));
  const all = tally(battles);
  const daily = loadDaily();
  const dailyWon = Object.values(daily).filter((d) => d.bestRounds !== null).length;
  const dailyTries = Object.values(daily).reduce((a, d) => a + d.attempts, 0);
  const captured = battles.reduce((a, r) => a + r.captured, 0);
  const recent = [...records].reverse().slice(0, 15);

  const byBot = (['dummy', 'hunter', 'master', 'god'] as PlayerType[]).map((b) => ({
    b,
    x: tally(battles.filter((r) => r.opponents.includes(b))),
  }));
  const online = tally(records.filter((r) => r.kind === 'duelOnline'));
  const training = tally(records.filter((r) => r.kind === 'duelTraining'));
  const local = records.filter((r) => r.kind === 'duelLocal' || (r.kind === 'single' && r.humans > 1)).length;

  const kindLabel = (r: GameRecord) => {
    if (r.kind === 'daily') return t('daily');
    if (r.kind === 'duelOnline') return t('duelOnline');
    if (r.kind === 'duelTraining') return t('duelTraining');
    if (r.kind === 'duelLocal') return t('duelLocal');
    return t(`size${r.size}` as 'sizeS');
  };

  return (
    <div class="screen">
      <div class="screen-inner">
        <TopBar title={t('statsTitle')} onBack={() => navigate({ name: 'menu' })} />
        <MedalProgress />
        {records.length === 0 ? (
          <div class="card muted" style={{ textAlign: 'center', padding: 28 }}>
            {t('sNoGames')}
          </div>
        ) : (
          <>
            <div class="section-title">{t('statBattles')}</div>
            <div class="big-stats">
              <div>
                <b>{all.n}</b>
                <span>{t('sGames')}</span>
              </div>
              <div>
                <b style={{ color: 'var(--good)' }}>{all.n ? `${pct(all)}%` : '—'}</b>
                <span>{t('statWinsShort', { w: all.w })}</span>
              </div>
              <div>
                <b style={{ color: 'var(--warn)' }}>{stats.bestStreak}</b>
                <span>{t('sBestStreak')}</span>
              </div>
            </div>

            <div class="section-title">{t('sVsBots')}</div>
            <div class="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {byBot.map(({ b, x }) => (
                <BarLine key={b} label={t(`player_${b}` as 'player_human')} x={x} />
              ))}
              <div class="muted" style={{ fontSize: 12, lineHeight: 1.4 }}>
                {t('statBotsNote')}
              </div>
            </div>

            <div class="section-title">{t('sBySize')}</div>
            <div class="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {SIZE_ORDER.map((sz) => (
                <BarLine key={sz} label={t(`size${sz}` as 'sizeS')} x={tally(battles.filter((r) => r.size === sz))} />
              ))}
            </div>

            <div class="section-title">{t('sDuels')}</div>
            <div class="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <BarLine label={t('statOnline')} x={online} />
              <BarLine label={t('statTraining')} x={training} />
              <div class="bar-line">
                <span style={{ flex: 1 }}>{t('statLocal')}</span>
                <span class="muted" style={{ fontSize: 13 }}>
                  {local || '—'}
                </span>
              </div>
            </div>

            <div class="big-stats">
              <div>
                <b>{dailyWon}</b>
                <span>{t('dailySolvedLabel')}</span>
              </div>
              <div>
                <b>{dailyTries}</b>
                <span>{t('statDailyTries')}</span>
              </div>
              <div>
                <b>{captured}</b>
                <span>{t('sCaptured')}</span>
              </div>
            </div>

            <div class="section-title">{t('sRecent')}</div>
            <div class="list">
              {recent.map((r, i) => {
                const mark = r.humans > 1 ? '•' : r.win ? t('statW') : t('statL');
                return (
                  <div class="list-item" key={i} style={{ minHeight: 52 }}>
                    <span
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 8,
                        display: 'grid',
                        placeItems: 'center',
                        fontWeight: 800,
                        fontSize: 13,
                        flex: 'none',
                        background: r.humans > 1 ? 'var(--surface-3)' : r.win ? 'color-mix(in srgb, var(--good) 22%, transparent)' : 'color-mix(in srgb, var(--bad) 20%, transparent)',
                        color: r.humans > 1 ? 'var(--muted)' : r.win ? 'var(--good)' : 'var(--bad)',
                      }}
                    >
                      {mark}
                    </span>
                    <div class="grow">
                      <div style={{ fontSize: 14, fontWeight: 700 }}>
                        {kindLabel(r)}
                        {r.opponents.length > 0 && (
                          <span class="muted" style={{ fontWeight: 600 }}>
                            {' · '}
                            {r.opponents.map((o) => t(`player_${o}` as 'player_human')).join(', ')}
                          </span>
                        )}
                      </div>
                      <div class="desc">
                        {new Date(r.at).toLocaleDateString(getLang() === 'ru' ? 'ru-RU' : 'en-US')} · {t('round', { n: r.rounds })}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
