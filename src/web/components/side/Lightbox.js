// @ts-check
// src/web/components/side/Lightbox.js — full-size image viewer (ux §5.3): the image is fetched lazily with
// tx.detail{field:'image'} (data: URL, allowed by img-src).
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { t } from '../chat/text.js';
import { act } from '../chat/env.js';
import { openOverlay, closeOverlay } from './overlays.js';
import { Modal } from './Popovers.js';

/** @param {string} chatId @param {string} ref @param {string} [mediaType] */
export function openLightbox(chatId, ref, mediaType) { openOverlay({ kind: 'lightbox', chatId, ref, ...(mediaType ? { mediaType } : {}) }); }

/** @param {{ chatId: string; imageRef?: string; dataUrl?: string }} p */
export function Lightbox({ chatId, imageRef, dataUrl }) {
  const [src, setSrc] = useState(dataUrl ?? '');
  const [err, setErr] = useState(false);
  useEffect(() => {
    if (dataUrl || !imageRef) return;
    act().detail(chatId, imageRef, 'image').then((d) => {
      if (d.dataUrl && /^data:image\//.test(d.dataUrl)) setSrc(d.dataUrl); else setErr(true);
    }, () => setErr(true));
  }, [chatId, imageRef, dataUrl]);
  return html`<${Modal} title=${t('tool.image', { taille: '' }).replace(/ · $/, '')} onClose=${closeOverlay} cls="c-lightbox">
    ${err ? html`<p>${t('tool.detail.error')}</p>` : src ? html`<img src=${src} alt="" decoding="async" />` : html`<p>${t('chat.loading')}</p>`}
  <//>`;
}
