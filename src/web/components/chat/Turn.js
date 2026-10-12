// @ts-check
// src/web/components/chat/Turn.js — one turn (ux §5.2): hidden h3 for heading navigation, the opening user message,
// the blocks laid out for the view mode, the footer (Détaillé; hover in Normal). content-visibility keeps off-screen
// turns cheap (ux §12.3). Each turn has its own error boundary (SPEC §9.2 item 8).
import { html } from 'htm/preact';
import { Component } from 'preact';
import { t } from './text.js';
import { layoutBlocks } from './model.js';
import { footerText } from './model.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { AssistantText, ThinkingBlock, UserMessage } from './Blocks.js';
import { ToolCard, ToolGroup } from './ToolCard.js';
import { SystemRow, detailedOnly } from './SystemRow.js';

/** @typedef {import('../../../shared/protocol.ts').UiTurn} UiTurn */
/** @typedef {import('../../../shared/protocol.ts').UiBlock} UiBlock */
/** @typedef {import('../../../shared/protocol.ts').ViewMode} ViewMode */

/** @typedef {{ chatId: string; sig: import('@preact/signals').Signal<UiTurn>; view: ViewMode; hit?: string | null }} TurnProps */
/** Memoised on its props: adding a turn never re-renders the others; streaming re-renders only the touched block.
 * @extends {Component<TurnProps>} */
export class Turn extends Component {
  /** @param {TurnProps} n */
  shouldComponentUpdate(n) { const p = this.props; return n.sig !== p.sig || n.view !== p.view || n.hit !== p.hit || n.chatId !== p.chatId; }
  render() { return html`<${ErrorBoundary} label="turn" chatId=${this.props.chatId}><${TurnInner} ...${this.props} /><//>`; }
}

/** @param {{ chatId: string; sig: import('@preact/signals').Signal<UiTurn>; view: ViewMode; hit?: string | null }} p */
function TurnInner({ chatId, sig, view, hit }) {
  const turn = sig.value;
  const items = layoutBlocks(turn.blocks, view, turn.user?.uuid);
  const head = turn.user;
  const h3 = head ? `${t('a11y.you')} : ${head.text.slice(0, 80)}` : t('a11y.claude');
  const cls = 'c-turn' + (turn.beforeCompaction ? ' c-before-compact' : '') + (hit === turn.id ? ' c-hit' : '');
  return html`<section class=${cls} data-turn=${turn.id} aria-label=${h3}>
    <h3 class="sr-only">${h3}</h3>
    ${turn.beforeCompaction ? html`<div class="c-before-label">${t('sys.beforeCompact')}</div>` : null}
    ${head ? html`<${UserMessage} chatId=${chatId} msg=${head} at=${turn.at} head=${true} />` : null}
    <div class="c-claude">
      ${items.map((it) => {
        if (it.kind === 'group') return html`<${ToolGroup} key=${it.id} chatId=${chatId} tools=${it.tools} />`;
        if (it.kind === 'folded') return html`<div key=${it.id} class="c-folded">${t('chat.folded', { n: it.count })}</div>`;
        return html`<${BlockView} key=${it.block.id} chatId=${chatId} block=${it.block} view=${view} hit=${hit} />`;
      })}
    </div>
    ${turn.footer ? html`<div class=${'c-footer' + (view === 'detailed' ? ' c-footer-on' : '')}>✓ ${footerText(turn.footer)}</div>` : null}
  </section>`;
}

/** @param {{ chatId: string; block: UiBlock; view: ViewMode; hit?: string | null }} p */
function BlockView({ chatId, block, view, hit }) {
  const mark = hit === block.id ? ' c-hit' : '';
  switch (block.k) {
    case 'user': return html`<div class=${mark}><${UserMessage} chatId=${chatId} msg=${block.msg} /></div>`;
    case 'text': return html`<div class=${'c-assistant' + mark} aria-label=${t('a11y.claude')}><${AssistantText} chatId=${chatId} block=${block} /></div>`;
    case 'thinking': return html`<${ThinkingBlock} chatId=${chatId} block=${block} expanded=${view === 'detailed'} />`;
    case 'tool': return html`<${ToolCard} chatId=${chatId} block=${block} expanded=${view === 'detailed' ? false : undefined} />`;
    case 'system': return detailedOnly(block.row) && view !== 'detailed' ? null : html`<${SystemRow} chatId=${chatId} id=${block.id} row=${block.row} />`;
    default: return null;
  }
}
