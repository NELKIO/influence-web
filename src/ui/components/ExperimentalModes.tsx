import { t } from '../../i18n';
import type { DarknessOptions } from '../../core/darknessOptions';
import { FRONTIER_MAX_POINTS, FRONTIER_MIN_POINTS } from '../../core/objectives';
import { frontierMajority, frontierWinChoice, frontierWinOf } from '../../storage';
import { SettingRow, Slider, Toggle } from './controls';

type Props = { options: DarknessOptions; update: (patch: Partial<DarknessOptions>) => void };
type Frontier = { frontierMode: boolean; frontierPoints: number; frontierWin: number | null };
type FrontierProps = { options: DarknessOptions & Partial<Frontier>; update: (patch: Partial<DarknessOptions & Frontier>) => void };

export function DarknessRow({ options, update }: Props) {
  return (
    <SettingRow title={t('darkness')} desc={t('darknessDesc')}>
      <Toggle label={t('darkness')} on={options.darkness} onChange={(darkness) => update(darkness ? { darkness } : { darkness, blind: false, signalFires: false })} />
    </SettingRow>
  );
}

export function ExperimentalModes({ options, update }: FrontierProps) {
  return (
    <>
      <div class="section-title">{t('experimentalModes')}</div>
      <div class="list">
        {typeof options.frontierMode === 'boolean' && <FrontierRows options={options as DarknessOptions & Frontier} update={update} />}
        {(['signalFires', 'blind'] as const).map((mode) => {
          const title = t(mode === 'blind' ? 'absoluteDarkness' : 'signalFires');
          return (
            <SettingRow key={mode} title={title} desc={t(mode === 'blind' ? 'absoluteDarknessDesc' : 'signalFiresDesc')}>
              <Toggle label={title} on={options[mode]} onChange={(on) => update({ [mode]: on, ...(on && { darkness: true }) })} />
            </SettingRow>
          );
        })}
      </div>
    </>
  );
}

/** The frontier switch and, when it is on, how many points the map has and how many win. */
function FrontierRows({ options, update }: { options: DarknessOptions & Frontier; update: FrontierProps['update'] }) {
  const points = options.frontierPoints;
  const win = frontierWinOf(options);
  const auto = options.frontierWin === null;
  return (
    <>
      <SettingRow title={t('frontierMode')} desc={t('frontierModeDesc', { n: points, k: win })}>
        <Toggle label={t('frontierMode')} on={options.frontierMode} onChange={(frontierMode) => update({ frontierMode })} />
      </SettingRow>
      {options.frontierMode && (
        <div class="frontier-sliders">
          <Slider
            title={t('frontierPoints')}
            value={points}
            min={FRONTIER_MIN_POINTS}
            max={FRONTIER_MAX_POINTS}
            // a custom requirement stays as chosen (cut to the new count); the majority follows the count
            onChange={(n) => update({ frontierPoints: n, frontierWin: auto ? null : frontierWinChoice(n, options.frontierWin!) })}
          />
          <Slider
            title={t('frontierWin')}
            value={win}
            min={1}
            max={points}
            valueText={`${win} / ${points}`}
            hint={auto ? t('frontierMajority') : t('frontierMajorityIs', { n: frontierMajority(points) })}
            onChange={(k) => update({ frontierWin: frontierWinChoice(points, k) })}
          />
        </div>
      )}
    </>
  );
}
