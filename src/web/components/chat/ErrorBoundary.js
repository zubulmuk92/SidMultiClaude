// @ts-check
// src/web/components/chat/ErrorBoundary.js — every Turn and ToolCard renders « Bloc illisible » on a render error and
// sends log.client (SPEC §9.2 item 8): a bad block never blanks the transcript.
import { Component } from 'preact';
import { html } from 'htm/preact';
import { t } from './text.js';
import { reportError } from './env.js';

/** @typedef {{ label?: string; chatId?: string; children?: import('preact').ComponentChildren }} Props */

/** @extends {Component<Props, { failed: boolean }>} */
export class ErrorBoundary extends Component {
  /** @param {Props} props */
  constructor(props) { super(props); this.state = { failed: false }; }
  /** @param {unknown} err */
  componentDidCatch(err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    reportError(`render ${this.props.label ?? 'block'}: ${msg}`, this.props.chatId);
    this.setState({ failed: true });
  }
  render() {
    if (this.state.failed) return html`<div class="c-unreadable" role="note">⚠ ${t('chat.blockError')}</div>`;
    return /** @type {import('preact').VNode} */ (/** @type {unknown} */ (this.props.children ?? null));
  }
}
