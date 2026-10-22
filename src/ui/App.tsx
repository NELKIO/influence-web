import { useEffect, useState } from 'preact/hooks';
import { resumeAll, setDuelNotifier, slotSession, listSlots } from './duels';
import { launchOnline } from './online';
import { t } from '../i18n';
import { sfx, buzz } from '../audio/sfx';
import { navigate, useRoute } from './store';
import { MenuScreen } from './screens/MenuScreen';
import { SetupScreen } from './screens/SetupScreen';
import { GameScreen } from './screens/GameScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { StatsScreen } from './screens/StatsScreen';
import { RulesScreen } from './screens/RulesScreen';
import { DailyScreen } from './screens/DailyScreen';
import { DuelsScreen } from './screens/DuelsScreen';
import { JoinScreen } from './screens/JoinScreen';

/** Invite links: #/duel/CODE (4 characters) and #/join/CODE (5-character battle rooms) */
function readInvite(): { kind: 'duel' | 'battle'; code: string } | null {
  const d = /^#\/duel\/([A-Za-z0-9]{4})$/.exec(location.hash);
  if (d) return { kind: 'duel', code: d[1].toUpperCase() };
  const b = /^#\/join\/([A-Za-z0-9]{5})$/.exec(location.hash);
  return b ? { kind: 'battle', code: b[1].toUpperCase() } : null;
}

function Notice() {
  const [n, setN] = useState<{ text: string; slot: string } | null>(null);
  useEffect(() => {
    let timer = 0;
    setDuelNotifier((kind, slot) => {
      const s = slotSession(slot);
      const code = s?.code ?? '';
      setN({ text: t(kind === 'turn' ? 'notifyTurn' : 'notifyEnd', { code }), slot });
      sfx.turn();
      buzz(30);
      clearTimeout(timer);
      timer = window.setTimeout(() => setN(null), 6000);
    });
    // reconnect saved duels in the background
    if (listSlots().length) resumeAll();
    return () => clearTimeout(timer);
  }, []);
  if (!n) return null;
  return (
    <div class="notice" role="status">
      <span>{n.text}</span>
      <button
        class="btn primary"
        onClick={() => {
          const s = slotSession(n.slot);
          setN(null);
          if (s?.state) launchOnline(s);
        }}
      >
        {t('notifyOpen')}
      </button>
    </div>
  );
}

export function App() {
  return (
    <>
      <Screens />
      <Notice />
    </>
  );
}

function Screens() {
  const route = useRoute();

  useEffect(() => {
    const check = () => {
      const inv = readInvite();
      if (!inv) return;
      history.replaceState(null, '', location.pathname + location.search);
      if (inv.kind === 'duel') navigate({ name: 'duels', join: inv.code });
      else navigate({ name: 'battleRoom', join: inv.code });
    };
    check();
    window.addEventListener('hashchange', check);
    return () => window.removeEventListener('hashchange', check);
  }, []);

  switch (route.name) {
    case 'menu':
      return <MenuScreen />;
    case 'setup':
      return <SetupScreen />;
    case 'game':
      return <GameScreen key={route.launch.state.seed + ':' + route.launch.state.startedAt} launch={route.launch} />;
    case 'settings':
      return <SettingsScreen />;
    case 'stats':
      return <StatsScreen />;
    case 'rules':
      return <RulesScreen />;
    case 'daily':
      return <DailyScreen />;
    case 'duels':
      return <DuelsScreen key={route.join ?? 'duels'} join={route.join} online={route.online} />;
    case 'join':
      return <JoinScreen code={route.code} />;
    case 'battleRoom':
      return <JoinScreen code={route.join} />;
  }
}
