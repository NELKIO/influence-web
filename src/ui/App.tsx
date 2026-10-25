import { Component, type ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { resumeAll, setDuelNotifier, slotSession, listSlots } from './duels';
import { launchOnline } from './online';
import { t } from '../i18n';
import { sfx, buzz } from '../audio/sfx';
import { initRouter, navigate, useRoute } from './store';
import { Modal } from './components/controls';
import { resetGameData } from '../storage';
import { MenuScreen } from './screens/MenuScreen';
import { SetupScreen } from './screens/SetupScreen';
import { GameScreen } from './screens/GameScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { StatsScreen } from './screens/StatsScreen';
import { RulesScreen } from './screens/RulesScreen';
import { DailyScreen } from './screens/DailyScreen';
import { DuelsScreen } from './screens/DuelsScreen';
import { JoinScreen } from './screens/JoinScreen';
import { BattleRoomScreen } from './screens/BattleRoomScreen';

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

// the address decides the first screen (a reload keeps it); back and forward move between screens
initRouter();

export function App() {
  return (
    <ErrorBoundary>
      <Screens />
      <Notice />
    </ErrorBoundary>
  );
}

/**
 * A screen that fails to render shows a way out instead of a blank page: back to the menu, or (when the
 * saved data is what breaks it) a reset of the game's data.
 */
class ErrorBoundary extends Component<{ children: ComponentChildren }, { error: unknown; ask: boolean }> {
  state = { error: null as unknown, ask: false };

  static getDerivedStateFromError(error: unknown) {
    return { error, ask: false };
  }

  componentDidCatch(error: unknown) {
    console.error('Influence Web: a screen failed to render', error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div class="screen crash-screen" data-testid="crash">
        <div class="screen-inner">
          <div class="card crash-card">
            <h1>{t('crashTitle')}</h1>
            <p class="muted">{t('crashText')}</p>
            <button
              class="btn primary"
              onClick={() => {
                this.setState({ error: null, ask: false });
                navigate({ name: 'menu' });
              }}
            >
              {t('toMenu')}
            </button>
            <button class="btn ghost" onClick={() => this.setState({ ask: true })}>
              {t('crashReset')}
            </button>
          </div>
        </div>
        {this.state.ask && (
          <Modal onBackdrop={() => this.setState({ ask: false })}>
            <h2>{t('crashReset')}</h2>
            <p>{t('crashResetConfirm')}</p>
            <div class="row">
              <button class="btn ghost" onClick={() => this.setState({ ask: false })}>
                {t('cancel')}
              </button>
              <button
                class="btn red"
                onClick={() => {
                  resetGameData();
                  location.replace(location.pathname + location.search);
                }}
              >
                {t('resetDo')}
              </button>
            </div>
          </Modal>
        )}
      </div>
    );
  }
}

function Screens() {
  const route = useRoute();

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
      return <BattleRoomScreen key={route.join ?? 'host'} join={route.join} />;
  }
}
