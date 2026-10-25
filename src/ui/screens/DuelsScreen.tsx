import { useState } from 'preact/hooks';
import { t } from '../../i18n';
import { getSettings, navigate, updateSettings, useSettings } from '../store';
import { Seg, SettingRow, Toggle, TopBar } from '../components/controls';
import { createMatch } from '../../core/engine';
import type { FieldSize, MatchSettings } from '../../core/types';
import { IconBot, IconChevron, IconUsers, IconWifi } from '../components/icons';
import { sfx, unlockAudio } from '../../audio/sfx';
import { OnlinePanel } from './OnlinePanel';
import { useDiscardGuard } from '../components/DiscardGuard';

export interface DuelOptions {
  size: FieldSize;
  darkness: boolean;
  turnTime: number;
}

const KEY = 'infweb.duelopts';

const DUEL_SIZES: FieldSize[] = ['M', 'L', 'XL'];
const DEFAULT_DUEL: DuelOptions = { size: 'L', darkness: false, turnTime: 0 };

/** Saved duel options, checked field by field: anything malformed falls back to its default. */
export function loadDuelOptions(): DuelOptions {
  let saved: unknown = null;
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    /* broken JSON: the defaults */
  }
  const o = (saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}) as Partial<Record<keyof DuelOptions, unknown>>;
  return {
    size: DUEL_SIZES.includes(o.size as FieldSize) ? (o.size as FieldSize) : DEFAULT_DUEL.size,
    darkness: typeof o.darkness === 'boolean' ? o.darkness : DEFAULT_DUEL.darkness,
    turnTime: typeof o.turnTime === 'number' && Number.isFinite(o.turnTime) && o.turnTime >= 0 ? o.turnTime : DEFAULT_DUEL.turnTime,
  };
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

export function DuelsScreen({ join, online: openOnline }: { join?: string; online?: boolean }) {
  useSettings();
  const [opts, setOpts] = useState<DuelOptions>(loadDuelOptions());
  const [online, setOnline] = useState<boolean>(!!join || !!openOnline);
  const { guard, modal } = useDiscardGuard();
  const update = (p: Partial<DuelOptions>) => {
    const n = { ...opts, ...p };
    setOpts(n);
    saveDuelOptions(n);
  };

  /** Start a match (after the overwrite question, if a saved match exists); `before` runs only on confirm. */
  const launch = (s: () => MatchSettings, before?: () => void) => {
    unlockAudio();
    guard(() => {
      before?.();
      sfx.versus();
      const st = createMatch(s());
      navigate({ name: 'game', launch: { state: st, initial: structuredClone(st) } });
    });
  };

  const training = () => {
    // first move alternates between training games: flipped only when the game really starts
    const localFirst = !getSettings().trainingLocalFirst;
    launch(
      () => duelSettings('duelTraining', opts, localFirst ? ['human', 'duelHunter'] : ['duelHunter', 'human']),
      () => updateSettings({ trainingLocalFirst: localFirst }),
    );
  };

  if (online) return <OnlinePanel opts={opts} join={join} onBack={() => setOnline(false)} />;

  return (
    <div class="screen">
      <div class="screen-inner">
        <TopBar title={t('duelsTitle')} onBack={() => navigate({ name: 'menu' })} />
        <p class="lead">{t('duelsDesc')}</p>

        <button class="choice red" onClick={() => setOnline(true)}>
          <span class="ic">
            <IconWifi />
          </span>
          <div>
            <div class="t">{t('duelOnline')}</div>
            <div class="d">{t('duelOnlineDesc')}</div>
          </div>
          <IconChevron class="chev" />
        </button>
        <button class="choice" onClick={training}>
          <span class="ic">
            <IconBot />
          </span>
          <div>
            <div class="t">{t('duelTraining')}</div>
            <div class="d">{t('duelTrainingDesc')}</div>
          </div>
          <IconChevron class="chev" />
        </button>
        <button class="choice yellow" onClick={() => launch(() => duelSettings('duelLocal', opts, ['human', 'human']))}>
          <span class="ic">
            <IconUsers />
          </span>
          <div>
            <div class="t">{t('duelLocal')}</div>
            <div class="d">{t('duelLocalDesc')}</div>
          </div>
          <IconChevron class="chev" />
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
      {modal}
    </div>
  );
}
