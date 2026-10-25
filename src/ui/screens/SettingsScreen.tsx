import { t } from '../../i18n';
import { navigate, updateSettings, useSettings } from '../store';
import { useEffect, useState } from 'preact/hooks';
import { readCounters, type SiteCounter } from '../../sitestats';
import { getLang } from '../../i18n';
import { Modal, Seg, SettingRow, Toggle, TopBar } from '../components/controls';
import { cleanPlayerName, PLAYER_NAME_MAX, resetAllData, type GameSpeed, type Palette } from '../../storage';
import { PALETTES } from '../theme';
import { PlayerToken } from '../components/icons';
import { ConnCheckPanel } from '../components/ConnCheck';


export function SettingsScreen() {
  const s = useSettings();
  const [askReset, setAskReset] = useState(false);
  return (
    <div class="screen">
      <div class="screen-inner">
        <TopBar title={t('settingsTitle')} onBack={() => navigate({ name: 'menu' })} />

        <div class="section-title">{t('sGeneral')}</div>
        <div class="list">
          <SettingRow title={t('language')}>
            <Seg
              value={s.lang ?? (document.documentElement.lang as 'ru' | 'en')}
              options={[
                { value: 'ru', label: 'RU' },
                { value: 'en', label: 'EN' },
              ]}
              onChange={(v) => updateSettings({ lang: v })}
            />
          </SettingRow>
          <SettingRow title={t('playerNameSetting')} desc={t('playerNameDesc')}>
            <input
              class="name-input"
              value={s.playerName}
              maxLength={PLAYER_NAME_MAX}
              placeholder={t('playerNamePlaceholder')}
              autoComplete="nickname"
              spellcheck={false}
              aria-label={t('playerNameSetting')}
              data-testid="player-name"
              onInput={(e) => updateSettings({ playerName: (e.target as HTMLInputElement).value.slice(0, PLAYER_NAME_MAX) })}
              onBlur={(e) => updateSettings({ playerName: cleanPlayerName((e.target as HTMLInputElement).value) })}
            />
          </SettingRow>
          <SettingRow title={t('sound')}>
            <Toggle on={s.sound} onChange={(v) => updateSettings({ sound: v })} />
          </SettingRow>
          <SettingRow title={t('vibration')}>
            <Toggle on={s.vibration} onChange={(v) => updateSettings({ vibration: v })} />
          </SettingRow>
          <div class="list-item" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <div class="title">{t('gameSpeed')}</div>
            <Seg<GameSpeed>
              value={s.speed}
              options={(['instant', 'fast', 'normal', 'slow'] as GameSpeed[]).map((v) => ({ value: v, label: t(`speed_${v}` as 'speed_fast') }))}
              onChange={(v) => updateSettings({ speed: v })}
            />
          </div>
          <SettingRow title={t('confirmEnd')} desc={t('confirmEndDesc')}>
            <Toggle on={s.confirmEnd} onChange={(v) => updateSettings({ confirmEnd: v })} />
          </SettingRow>
          <SettingRow title={t('showChance')}>
            <Toggle on={s.showChance} onChange={(v) => updateSettings({ showChance: v })} />
          </SettingRow>
        </div>

        <div class="section-title">{t('connCheck')}</div>
        <div class="list">
          <ConnCheckPanel />
        </div>

        <div class="section-title">{t('sBoard')}</div>
        <div class="list">
          <div class="list-item" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <div class="title">{t('cellLines')}</div>
            <Seg<100 | 50 | 0>
              value={s.cellLines}
              options={[
                { value: 100, label: t('lines_100') },
                { value: 50, label: t('lines_50') },
                { value: 0, label: t('lines_0') },
              ]}
              onChange={(v) => updateSettings({ cellLines: v })}
            />
          </div>
          <SettingRow title={t('inactiveCells')}>
            <Toggle on={s.inactiveCells} onChange={(v) => updateSettings({ inactiveCells: v })} />
          </SettingRow>
          <SettingRow title={t('colorblind')} desc={t('colorblindDesc')}>
            <Toggle on={s.colorblind} onChange={(v) => updateSettings({ colorblind: v })} />
          </SettingRow>
          <div class="list-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
            <div class="title">{t('palette')}</div>
            <Seg<Palette>
              value={s.palette}
              options={(Object.keys(PALETTES) as Palette[]).map((p) => ({ value: p, label: t(`palette_${p}` as 'palette_main') }))}
              onChange={(v) => updateSettings({ palette: v })}
            />
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              {[0, 1, 2, 3, 4].map((i) => (
                <PlayerToken key={i} slot={i} size={28} shape={s.colorblind} />
              ))}
            </div>
          </div>
          <SettingRow title={t('lowFx')} desc={t('lowFxDesc')}>
            <Toggle on={s.lowFx} onChange={(v) => updateSettings({ lowFx: v })} />
          </SettingRow>
        </div>

        <button class="btn ghost small" onClick={() => setAskReset(true)}>
          {t('resetData')}
        </button>
        {askReset && (
          <Modal onBackdrop={() => setAskReset(false)}>
            <h2>{t('resetData')}</h2>
            <p>{t('resetConfirm')}</p>
            <div class="row">
              <button class="btn ghost" onClick={() => setAskReset(false)}>
                {t('cancel')}
              </button>
              <button
                class="btn red"
                onClick={() => {
                  resetAllData();
                  setAskReset(false);
                }}
              >
                {t('resetDo')}
              </button>
            </div>
          </Modal>
        )}
        <SiteStats />
        <div class="fan-note">
          {t('version', { v: __APP_VERSION__ })}
          <br />
          {t('fanNote')}
        </div>
      </div>
    </div>
  );
}

/** Anonymous counters of the whole site (all players together). */
function SiteStats() {
  const [values, setValues] = useState<Record<SiteCounter, number | null> | null>(null);
  useEffect(() => {
    let alive = true;
    void readCounters().then((v) => alive && setValues(v));
    return () => {
      alive = false;
    };
  }, []);
  const fmt = (n: number | null | undefined) =>
    values === null ? '…' : n === null || n === undefined ? '—' : n.toLocaleString(getLang() === 'ru' ? 'ru-RU' : 'en-US');
  return (
    <>
      <div class="section-title">{t('siteStats')}</div>
      <div class="big-stats" data-testid="site-stats">
        <div>
          <b>{fmt(values?.opens)}</b>
          <span>{t('siteOpens')}</span>
        </div>
        <div>
          <b>{fmt(values?.visitors)}</b>
          <span>{t('siteVisitors')}</span>
        </div>
        <div>
          <b>{fmt(values?.games)}</b>
          <span>{t('siteGames')}</span>
        </div>
      </div>
      <p class="muted" style={{ fontSize: 12, lineHeight: 1.5, margin: '0 4px', textAlign: 'center' }}>
        {t('siteStatsNote')}
      </p>
    </>
  );
}
