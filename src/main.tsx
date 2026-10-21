import { render } from 'preact';
import '@fontsource/manrope/400.css';
import '@fontsource/manrope/500.css';
import '@fontsource/manrope/600.css';
import '@fontsource/manrope/700.css';
import '@fontsource/manrope/800.css';
import '@fontsource/unbounded/500.css';
import '@fontsource/unbounded/600.css';
import '@fontsource/unbounded/700.css';
import './ui/styles.css';
import './ui/store';
import { App } from './ui/App';
import { countVisit } from './sitestats';

const root = document.getElementById('app')!;
// drop the static description used by search engines / before the app starts
root.textContent = '';
render(<App />, root);
countVisit();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
  });
}
