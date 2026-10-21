import { useMemo, useState } from 'preact/hooks';
import { getLang, t } from '../../i18n';
import { navigate, useSettings } from '../store';
import { TopBar } from '../components/controls';
import { createDailyMatch, dailySettings, dayId, dayNumber, parseDay } from '../../daily';
import { loadDaily, loadSavedGame } from '../../storage';
import { IconBack, IconArrow, PlayerToken } from '../components/icons';
import { SIZES } from '../../core/types';
import { sfx, unlockAudio } from '../../audio/sfx';

const FIRST_DAY = '2026-01-01';

export function DailyScreen() {
  const settings = useSettings();
  const today = dayId();
  const [sel, setSel] = useState(today);
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const results = loadDaily();
  const cfg = useMemo(() => dailySettings(sel), [sel]);
  const res = results[sel];

  const streak = useMemo(() => {
    let n = 0;
    const d = parseDay(today);
    if (!results[today]?.bestRounds) d.setDate(d.getDate() - 1);
    while (results[dayId(d)]?.bestRounds) {
      n++;
      d.setDate(d.getDate() - 1);
    }
    return n;
  }, [results, today]);
  const solved = Object.values(results).filter((r) => r.bestRounds !== null).length;

  const play = () => {
    unlockAudio();
    sfx.click();
    const saved = loadSavedGame();
    if (saved && saved.state.settings.kind === 'daily' && saved.state.settings.dailyId === sel) {
      navigate({ name: 'game', launch: { state: saved.state, initial: saved.initial } });
      return;
    }
    const st = createDailyMatch(sel);
    navigate({ name: 'game', launch: { state: st, initial: structuredClone(st) } });
  };

  // calendar grid (Monday first)
  const first = new Date(month);
  const startOffset = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells: (string | null)[] = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(dayId(new Date(month.getFullYear(), month.getMonth(), d)));
  const locale = getLang() === 'ru' ? 'ru-RU' : 'en-US';
  const dows = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(locale, { weekday: 'narrow' }));
  const canPrev = dayId(new Date(month.getFullYear(), month.getMonth(), 0)) >= FIRST_DAY;
  const canNext = new Date(month.getFullYear(), month.getMonth() + 1, 1) <= new Date();

  return (
    <div class="screen">
      <div class="screen-inner">
        <TopBar title={t('dailyTitle')} onBack={() => navigate({ name: 'menu' })} />
        <p class="muted" style={{ margin: '0 4px', fontSize: 14, lineHeight: 1.45 }}>
          {t('dailyDesc')}
        </p>

        <div class="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 22, fontWeight: 800 }}>
              #{dayNumber(sel)}{' '}
              <span class="muted" style={{ fontSize: 14, fontWeight: 600 }}>
                {sel === today ? t('today') : parseDay(sel).toLocaleDateString(locale, { day: 'numeric', month: 'long' })}
              </span>
            </div>
            <div class="muted" style={{ fontSize: 13 }}>
              {cfg.size} · {SIZES[cfg.size].w}×{SIZES[cfg.size].h}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span class="muted" style={{ fontSize: 13 }}>
              {t('dailyOpponents')}:
            </span>
            {cfg.players.slice(1).map((p, i) => (
              <span key={i} class="pchip" style={{ '--c': `var(--p${i + 1})` }}>
                <PlayerToken slot={i + 1} size={14} shape={settings.colorblind} />
                {t(`player_${p}` as 'player_human')}
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {cfg.darkness && <span class="pchip">{t('darkness')}</span>}
            {cfg.symmetry && <span class="pchip">{t('symmetry')}</span>}
            {cfg.unions && <span class="pchip">{t('unions')}</span>}
          </div>
          <div style={{ fontSize: 15, fontWeight: 700, color: res?.bestRounds ? 'var(--good)' : 'var(--muted)' }}>
            {res?.bestRounds ? t('dailyBest', { n: res.bestRounds }) : t('dailyNoWin')}
            {res?.attempts ? <span class="muted" style={{ fontWeight: 500 }}> · {t('dailyAttempts', { n: res.attempts })}</span> : null}
          </div>
          <button class="btn green" onClick={play}>
            {res?.attempts ? t('dailyRetry') : t('dailyPlay')}
          </button>
        </div>

        <div class="big-stats" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div>
            <b style={{ color: 'var(--warn)' }}>{streak}</b>
            <span>{t('dailyStreakLabel')}</span>
          </div>
          <div>
            <b style={{ color: 'var(--good)' }}>{solved}</b>
            <span>{t('dailySolvedLabel')}</span>
          </div>
        </div>

        <div class="section-title">{t('dailyArchive')}</div>
        <div class="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <button
              class="icon-btn"
              disabled={!canPrev}
              style={{ opacity: canPrev ? 1 : 0.3 }}
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
            >
              <IconBack />
            </button>
            <div style={{ fontWeight: 700, textTransform: 'capitalize' }}>{month.toLocaleDateString(locale, { month: 'long', year: 'numeric' })}</div>
            <button
              class="icon-btn"
              disabled={!canNext}
              style={{ opacity: canNext ? 1 : 0.3 }}
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
            >
              <IconArrow />
            </button>
          </div>
          <div class="calendar">
            {dows.map((d, i) => (
              <div class="dow" key={`d${i}`}>
                {d}
              </div>
            ))}
            {cells.map((id, i) => {
              if (!id) return <div key={i} />;
              const r = results[id];
              const future = id > today || id < FIRST_DAY;
              const cls = [
                'cal-day',
                r?.bestRounds ? 'won' : r?.attempts ? 'tried' : '',
                id === today ? 'today' : '',
                id === sel ? 'sel' : '',
                future ? 'future' : '',
              ].join(' ');
              return (
                <button
                  key={id}
                  class={cls}
                  disabled={future}
                  onClick={() => {
                    sfx.click();
                    setSel(id);
                  }}
                >
                  {parseDay(id).getDate()}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
