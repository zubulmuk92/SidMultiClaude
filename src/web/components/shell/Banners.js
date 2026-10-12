// @ts-check
// src/web/components/shell/Banners.js — window-level banners: WebSocket lost / reconnected (err.ws, err.ws.ok), session
// expired (6.1 §5), server closed, and the notification-permission prompt (notif.enable: on the first relevant event,
// never at load).
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { t, tParts } from '../../lib/i18n.js';
import { requestPermission } from '../../lib/notify.js';
import { conn, hydrated } from '../../store.js';
import { reconnectNow } from '../../net.js';

/** Set by main.js when a notification would have been shown while the permission is still 'default'. */
export const notifPrompt = signal(false);

export function Banners() {
  const c = conn.value;
  const [okUntil, setOkUntil] = useState(0);
  const [wasDown, setWasDown] = useState(false);
  useEffect(() => {
    if (c.status === 'reconnecting') setWasDown(true);
    if (c.status === 'open' && wasDown) {
      setWasDown(false);
      setOkUntil(Date.now() + 2500);
      const tm = setTimeout(() => setOkUntil(0), 2600);
      return () => clearTimeout(tm);
    }
    return undefined;
  }, [c.status]);
  const parts = tParts('notif.enable');
  return html`<div class="banners" role="region" aria-label=${t('shell.banners.label')}>
    ${c.status === 'reconnecting' ? html`<div class="banner warn" role="status">${t('err.ws')}
      <button type="button" class="btn sm" onClick=${() => reconnectNow()}>${t('shell.retry')}</button></div>` : null}
    ${c.status === 'open' && okUntil > Date.now() ? html`<div class="banner ok" role="status">${t('err.ws.ok')}</div>` : null}
    ${c.status === 'expired' ? html`<div class="banner error" role="alert">${t('shell.expired')}</div>` : null}
    ${c.status === 'closed' ? html`<div class="banner error" role="alert">${t('shell.closed')}</div>` : null}
    ${c.status === 'connecting' && !hydrated.value ? html`<div class="banner info" role="status">${t('shell.status.conn.connecting')}</div>` : null}
    ${notifPrompt.value ? html`<div class="banner info" role="status">${parts[0]}
      <button type="button" class="btn sm primary" onClick=${() => { notifPrompt.value = false; void requestPermission(); }}>${parts[1]}</button>
      <button type="button" class="btn sm" onClick=${() => { notifPrompt.value = false; }}>${parts[2]}</button></div>` : null}
  </div>`;
}
