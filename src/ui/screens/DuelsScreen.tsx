import { useState } from 'preact/hooks';
import { t } from '../../i18n';
import { getSettings, navigate, updateSettings, useSettings } from '../store';
import { Seg, SettingRow, Toggle, TopBar } from '../components/controls';
import { createMatch } from '../../core/engine';
import type { FieldSize, MatchSettings } from '../../core/types';
import { IconBot, IconUsers, IconWifi } from '../components/icons';
import { sfx, unlockAudio } from '../../audio/sfx';
import { OnlinePanel } from './OnlinePanel';

export interface DuelOptions {
  size: FieldSize;
  darkness: boolean;
  turnTime: number;
}

const KEY = 'infweb.duelopts';

export function loadDuelOptions(): DuelOptions {
  try {
    return { size: 'L', darkness: false, turnTime: 0, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { size: 'L', darkness: false, turnTime: 0 };
  }
}

function saveDuelOptions(o: DuelOptions) {
  try {
    localStorage.setItem(KEY, JSON.stringify(o));
  } catch {
    /* ignore */
  }
}

export function duelSettings(kind: MatchSettings['kind'], o: DuelOptions, players: MatchSettings['players']): MatchSettings {
  return {
    kind,
    size: o.size,
    players,
    darkness: o.darkness,
    symmetry: true,
    crowded: false,
    unions: false,
    shuffle: false,
    duelRules: true,
    turnTime: o.turnTime || undefined,
  };
}

export function DuelsScreen({ join }: { join?: string }) {
  useSettings();
  const [opts, setOpts] = useState<DuelOptions>(loadDuelOptions());
  const [online, setOnline] = useState<boolean>(!!join);
  const update = (p: Partial<DuelOptions>) => {
    const n = { ...opts, ...p };
    setOpts(n);
    saveDuelOptions(n);
  };

  const launch = (s: MatchSettings) => {
    unlockAudio();
    sfx.versus();
    const st = createMatch(s);
    navigate({ name: 'game', launch: { state: st, initial: structuredClone(st) } });
  };

  const training = () => {
    // first move alternates between training games
    const localFirst = !getSettings().trainingLocalFirst;
    updateSettings({ trainingLocalFirst: localFirst });
    launch(duelSettings('duelTraining', opts, localFirst ? ['human', 'duelHunter'] : ['duelHunter', 'human']));
  };

  if (online) return <OnlinePanel opts={opts} join={join} onBack={() => setOnline(false)} />;

  return (
    <div class="screen">
      <div class="screen-inner">
        <TopBar title={t('duelsTitle')} onBack={() => navigate({ name: 'menu' })} />
        <p class="muted" style={{ margin: '0 4px', fontSize: 14 }}>
          {t('duelsDesc')}
        </p>

        <button class="choice red" onClick={() => setOnline(true)}>
          <IconWifi />
          <div>
            <div class="t">{t('duelOnline')}</div>
            <div class="d">{t('duelOnlineDesc')}</div>
          </div>
        </button>
        <button class="choice" onClick={training}>
          <IconBot />
          <div>
            <div class="t">{t('duelTraining')}</div>
            <div class="d">{t('duelTrainingDesc')}</div>
          </div>
        </button>
        <button class="choice yellow" onClick={() => launch(duelSettings('duelLocal', opts, ['human', 'human']))}>
          <IconUsers />
          <div>
            <div class="t">{t('duelLocal')}</div>
            <div class="d">{t('duelLocalDesc')}</div>
          </div>
        </button>

        <div class="section-title">{t('settings')}</div>
        <div class="list">
          <div class="list-item" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <div class="title">{t('mapSize')}</div>
            <Seg<FieldSize>
              value={opts.size}
              options={(['M', 'L', 'XL'] as FieldSize[]).map((v) => ({ value: v, label: t(`size${v}` as 'sizeM') }))}
              onChange={(v) => update({ size: v })}
            />
          </div>
          <SettingRow title={t('darkness')} desc={t('darknessDesc')}>
            <Toggle on={opts.darkness} onChange={(v) => update({ darkness: v })} />
          </SettingRow>
        </div>

        <div class="section-title">{t('duelRulesTitle')}</div>
        <div class="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(['duelRule1', 'duelRule2', 'duelRule3'] as const).map((k) => (
            <div key={k} class="muted" style={{ fontSize: 14, lineHeight: 1.45 }}>
              • {t(k)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
