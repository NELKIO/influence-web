/**
 * Page visibility for the "the other player minimised the game" notices: mobile browsers throttle or
 * suspend a hidden tab (often the player just switched to a messenger to send the invite code), so
 * each side tells the others when its page is hidden.
 */
import type { Unsubscribe } from './emitter';

export function pageHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/** `cb(hidden)` on every visibility change of this page */
export function onVisibility(cb: (hidden: boolean) => void): Unsubscribe {
  if (typeof document === 'undefined') return () => {};
  const h = () => cb(document.visibilityState === 'hidden');
  document.addEventListener('visibilitychange', h);
  return () => document.removeEventListener('visibilitychange', h);
}
