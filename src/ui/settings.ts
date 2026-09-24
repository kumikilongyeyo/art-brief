import { DEFAULT_INSTRUCTION, type Settings } from '../storage';
import { h, icon } from './dom';

export interface SettingsHandlers {
  change: (patch: Partial<Settings>) => void;
  exportSaved: () => void;
  importSaved: (file: File) => void;
  clearHistory: () => void;
  clearSaved: () => void;
}

export interface SettingsInfo {
  appVersion: string;
  dataVersion: string;
  savedCount: number;
  historyCount: number;
  storageOk: boolean;
}

let open: { close: () => void } | null = null;

export function closeSettings() {
  open?.close();
}

export function openSettings(settings: Settings, info: SettingsInfo, hd: SettingsHandlers, opener?: HTMLElement) {
  closeSettings();
  const scrim = h('div', { class: 'scrim' });
  const radio = (name: string, value: string, label: string, checked: boolean, onchange: () => void) =>
    h('label', { class: 'check' }, h('input', { type: 'radio', name, value, checked, onchange }), label);

  const textarea = h('textarea', { id: 'instruction', 'aria-label': 'ChatGPT instruction', spellcheck: 'false' });
  textarea.value = settings.instruction;
  textarea.addEventListener('change', () => hd.change({ instruction: textarea.value.trim() ? textarea.value : DEFAULT_INSTRUCTION }));

  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) hd.importSaved(f);
    fileInput.value = '';
  });

  const panel = h(
    'div',
    { class: 'panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'settings-title' },
    h(
      'div',
      { class: 'panel-head' },
      h('h2', { id: 'settings-title' }, 'Settings'),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close settings', onclick: () => close() }, icon('close')),
    ),
    h(
      'section',
      {},
      h('h3', {}, 'ChatGPT hand-off'),
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          id: 'opt-chatgpt',
          checked: settings.showChatGPT,
          onchange: (e: Event) => hd.change({ showChatGPT: (e.target as HTMLInputElement).checked }),
        }),
        'Show “Copy for ChatGPT” button',
      ),
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: settings.openChatGPT,
          onchange: (e: Event) => hd.change({ openChatGPT: (e.target as HTMLInputElement).checked }),
        }),
        'Open ChatGPT after copying',
      ),
      h('label', { for: 'instruction', class: 'small' }, 'Instruction ({{brief}} is replaced by the brief)'),
      textarea,
      h(
        'div',
        { class: 'btns' },
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: () => {
              textarea.value = DEFAULT_INSTRUCTION;
              hd.change({ instruction: DEFAULT_INSTRUCTION });
            },
          },
          'Reset to default',
        ),
      ),
    ),
    h(
      'section',
      { role: 'radiogroup', 'aria-labelledby': 'uq-h' },
      h('h3', { id: 'uq-h' }, 'Unique trait frequency'),
      radio('uq', 'never', 'Never', settings.uniqueFrequency === 'never', () => hd.change({ uniqueFrequency: 'never' })),
      radio('uq', 'sometimes', 'Sometimes', settings.uniqueFrequency === 'sometimes', () => hd.change({ uniqueFrequency: 'sometimes' })),
      radio('uq', 'often', 'Often', settings.uniqueFrequency === 'often', () => hd.change({ uniqueFrequency: 'often' })),
    ),
    h(
      'section',
      { role: 'radiogroup', 'aria-labelledby': 'th-h' },
      h('h3', { id: 'th-h' }, 'Appearance'),
      radio('cs', 'system', 'System', settings.colorScheme === 'system', () => hd.change({ colorScheme: 'system' })),
      radio('cs', 'light', 'Light', settings.colorScheme === 'light', () => hd.change({ colorScheme: 'light' })),
      radio('cs', 'dark', 'Dark', settings.colorScheme === 'dark', () => hd.change({ colorScheme: 'dark' })),
    ),
    h(
      'section',
      {},
      h('h3', {}, 'Saved briefs'),
      h(
        'div',
        { class: 'btns' },
        h('button', { class: 'btn', type: 'button', onclick: () => hd.exportSaved() }, `Export saved (${info.savedCount})`),
        h('button', { class: 'btn', type: 'button', onclick: () => fileInput.click() }, 'Import…'),
        fileInput,
      ),
      h(
        'p',
        { class: 'small' },
        'Saved briefs live in this browser only. On iPhone, the Home Screen app and Safari keep separate storage — use Export / Import to move them.',
      ),
      info.storageOk
        ? null
        : h('p', { class: 'small' }, 'Storage is unavailable in this browser mode, so nothing is kept after you close the page.'),
      h(
        'div',
        { class: 'btns' },
        h(
          'button',
          { class: 'btn danger', type: 'button', onclick: () => confirm('Clear all history?') && hd.clearHistory() },
          `Clear history (${info.historyCount})`,
        ),
        h(
          'button',
          {
            class: 'btn danger',
            type: 'button',
            onclick: () => confirm('Delete all saved briefs? Export first if you want a backup.') && hd.clearSaved(),
          },
          'Clear saved',
        ),
      ),
    ),
    h('section', {}, h('h3', {}, 'About'), h('p', { class: 'small', id: 'version' }, `app ${info.appVersion} · data ${info.dataVersion}`)),
  );

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Tab') {
      const f = [...panel.querySelectorAll<HTMLElement>('button, input:not([tabindex="-1"]), textarea')].filter(
        (x) => !x.hasAttribute('disabled'),
      );
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) {
        e.preventDefault();
        f[f.length - 1].focus();
      } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
        e.preventDefault();
        f[0].focus();
      }
    }
  };
  function close() {
    scrim.remove();
    panel.remove();
    document.removeEventListener('keydown', onKey, true);
    open = null;
    opener?.focus();
  }
  scrim.addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);
  document.body.append(scrim, panel);
  open = { close };
  panel.querySelector<HTMLElement>('button')?.focus();
}
