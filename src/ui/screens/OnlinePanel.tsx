import { t } from '../../i18n';
import { TopBar } from '../components/controls';
import type { DuelOptions } from './DuelsScreen';

export function OnlinePanel({ onBack }: { opts: DuelOptions; join?: string; onBack: () => void }) {
  return (
    <div class="screen">
      <div class="screen-inner">
        <TopBar title={t('duelOnline')} onBack={onBack} />
        <div class="card muted">{t('duelConnecting')}</div>
      </div>
    </div>
  );
}
