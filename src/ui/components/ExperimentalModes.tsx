import { t } from '../../i18n';
import type { DarknessOptions } from '../../core/darknessOptions';
import { SettingRow, Toggle } from './controls';

type Props = { options: DarknessOptions; update: (patch: Partial<DarknessOptions>) => void };

export function DarknessRow({ options, update }: Props) {
  return (
    <SettingRow title={t('darkness')} desc={t('darknessDesc')}>
      <Toggle label={t('darkness')} on={options.darkness} onChange={(darkness) => update(darkness ? { darkness } : { darkness, blind: false, signalFires: false })} />
    </SettingRow>
  );
}

export function ExperimentalModes({ options, update }: Props) {
  return (
    <>
      <div class="section-title">{t('experimentalModes')}</div>
      <div class="list">
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
