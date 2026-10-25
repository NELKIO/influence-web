import { useMemo, useState } from 'preact/hooks';
import { getLang, t } from '../../i18n';
import { navigate, useSettings } from '../store';
import { TopBar } from '../components/controls';
import { createDailyAttempt, createDailyMatch, dailyLevel, dayId, dayNumber, parseDay, type ScenarioId } from '../../daily';
import { loadDaily, loadSavedGame } from '../../storage';
import { IconBack, IconArrow } from '../components/icons';
import { SecretMap } from '../components/MiniMap';
import { useDiscardGuard } from '../components/DiscardGuard';
import { sfx, unlockAudio } from '../../audio/sfx';
import { playerName } from '../names';

const FIRST_DAY = '2026-01-01';

export function DailyScreen() {
  useSettings();
  const { guard, modal } = useDiscardGuard();
  const today = dayId();
  const [sel, setSel] = useState(today);
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const results = loadDaily();
  const preview = useMemo(() => createDailyMatch(sel), [sel]);
  const cfg = preview.settings;
  const puzzle = cfg.puzzle as ScenarioId | undefined;
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

  const savedGame = loadSavedGame();
  /** an unfinished attempt at this day is saved: the button resumes it */
  const resumable = !!savedGame && savedGame.state.settings.kind === 'daily' && savedGame.state.settings.dailyId === sel && !savedGame.state.ended;

  const play = () => {
    unlockAudio();
    sfx.click();
    const saved = loadSavedGame();
    if (saved && saved.state.settings.kind === 'daily' && saved.state.settings.dailyId === sel) {
      navigate({ name: 'game', launch: { state: saved.state, initial: saved.initial } });
      return;
    }
    guard(() => {
      // the day's map as everybody gets it, with dice of this attempt's own
      const st = createDailyAttempt(sel);
      navigate({ name: 'game', launch: { state: st, initial: structuredClone(st) } });
    });
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
        <p class="lead">{t('dailyDesc')}</p>

        <div class="card" style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 18 }}>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div class="result-sub" style={{ marginBottom: 8 }}>
                {sel === today ? t('today') : parseDay(sel).toLocaleDateString(locale, { day: 'numeric', month: 'long' })}
              </div>
              <div class="daily-num">#{dayNumber(sel)}</div>
              <div class="difficulty" title={t('dailyLevel')}>
                {[1, 2, 3, 4, 5].map((k) => (
                  <i key={k} class={k <= dailyLevel(sel) ? 'on' : ''} />
                ))}
                <span>{t(`dailyLevel${dailyLevel(sel)}` as 'dailyLevel1')}</span>
              </div>
              <div class="muted" style={{ fontSize: 13, fontWeight: 600, marginTop: 8 }}>
                {puzzle ? t('dailyPuzzle') : t('dailyBattle')} · {t('mapCells', { n: preview.field.cells.length })}
              </div>
            </div>
            <div style={{ width: 120, flex: 'none' }}>
              {/* a scenario in darkness gives away neither the starts nor (under exploration fog) the map */}
              <SecretMap field={preview.field} darkness={!!puzzle && cfg.darkness} blind={cfg.blind} maxHeight={130} />
            </div>
          </div>
          {puzzle && (
            <div class="puzzle-brief">
              <div class="title">{t(`puzzle_${puzzle}` as 'puzzle_siege')}</div>
              <div class="desc">{t(`puzzleDesc_${puzzle}` as 'puzzleDesc_siege')}</div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {cfg.players.slice(1).map((_, i) => (
              <span key={i} class="tag" style={{ '--c': `var(--p${i + 1})` }}>
                <span class="sw" />
                {playerName(cfg, i + 1)}
              </span>
            ))}
            {cfg.darkness && <span class="tag">{t('darkness')}</span>}
            {cfg.blind && <span class="tag">{t('scenarioUncharted')}</span>}
            {cfg.symmetry && <span class="tag">{t('symmetry')}</span>}
            {cfg.unions && <span class="tag">{t('unions')}</span>}
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, color: res?.bestRounds ? 'var(--good)' : 'var(--muted)' }}>
            {res?.bestRounds ? t('dailyBest', { n: res.bestRounds }) : t('dailyNoWin')}
            {res?.attempts ? <span class="muted" style={{ fontWeight: 600 }}> · {t('dailyAttempts', { n: res.attempts })}</span> : null}
          </div>
          <button class="btn primary" onClick={play}>
            {resumable ? t('continue') : res?.attempts ? t('dailyRetry') : t('dailyPlay')}
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
      {modal}
    </div>
  );
}
