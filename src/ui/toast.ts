import { h } from './dom';

let el: HTMLElement | null = null;
let timer: number | undefined;

export interface ToastAction {
  label: string;
  run: () => void;
}

/** Brief status message. With an action (e.g. Undo) it stays longer and the button is clickable. */
export function toast(message: string, opts: number | { ms?: number; action?: ToastAction } = {}) {
  const o = typeof opts === 'number' ? { ms: opts } : opts;
  const ms = o.ms ?? (o.action ? 6000 : 1500);
  if (!el) {
    el = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  el.replaceChildren(h('span', {}, message));
  el.classList.toggle('has-action', !!o.action);
  if (o.action) {
    const action = o.action;
    el.append(
      h(
        'button',
        {
          class: 'toast-action',
          type: 'button',
          onclick: () => {
            hideToast();
            action.run();
          },
        },
        action.label,
      ),
    );
  }
  el.hidden = false;
  window.clearTimeout(timer);
  timer = window.setTimeout(hideToast, ms);
}

export function hideToast() {
  if (el) el.hidden = true;
}
