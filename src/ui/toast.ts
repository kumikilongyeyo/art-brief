import { h } from './dom';

let el: HTMLElement | null = null;
let timer: number | undefined;

export function toast(message: string, ms = 1500) {
  if (!el) {
    el = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  el.textContent = message;
  el.hidden = false;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    if (el) el.hidden = true;
  }, ms);
}
