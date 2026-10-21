import { useEffect } from 'preact/hooks';
import { navigate, useRoute } from './store';
import { MenuScreen } from './screens/MenuScreen';
import { SetupScreen } from './screens/SetupScreen';
import { GameScreen } from './screens/GameScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { StatsScreen } from './screens/StatsScreen';
import { RulesScreen } from './screens/RulesScreen';
import { DailyScreen } from './screens/DailyScreen';
import { DuelsScreen } from './screens/DuelsScreen';

/** Invite links look like #/duel/CODE */
function readInvite(): string | null {
  const m = /^#\/duel\/([A-Za-z0-9]{4})$/.exec(location.hash);
  return m ? m[1].toUpperCase() : null;
}

export function App() {
  const route = useRoute();

  useEffect(() => {
    const code = readInvite();
    if (code) {
      history.replaceState(null, '', location.pathname + location.search);
      navigate({ name: 'duels', join: code });
    }
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
      return <DuelsScreen join={route.join} />;
  }
}
