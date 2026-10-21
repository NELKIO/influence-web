import { render } from 'preact';
import '@fontsource/exo-2/400.css';
import '@fontsource/exo-2/600.css';
import '@fontsource/exo-2/700.css';
import '@fontsource/exo-2/800.css';
import './ui/styles.css';
import './ui/store';
import { App } from './ui/App';

render(<App />, document.getElementById('app')!);
