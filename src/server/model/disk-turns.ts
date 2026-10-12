// src/server/model/disk-turns.ts — RawEntry chain → UiTurn[] (+ heavy locations); same ids as live.
// Rules: ux §5. Pure. The "live = reload" invariant (test/unit/model/live-reload.test.ts) keeps this file
// and live-reducer.ts in step: same ids, kinds, texts, statuses and tool summaries.
import type { DiskToTurns, HeavyLoc, RawEntry } from '../contracts.ts';
import type * as P from '../../shared/protocol.ts';
import { SYNTHETIC, arr, blockId, contentImages, contentText, cut, imageRefId, imageRefs, isInterruptText, isoMs, localCommandText, localRow, num, optStr, rec, str, userOrigin } from './blocks.ts';
import type { Rec } from './blocks.ts';
import { inputIsHeavy, liteToolResult, toolInputView } from './tools-lite.ts';
import { footerFromUsages } from './accounting.ts';

const CHAIN_TYPES = new Set(['user', 'assistant', 'attachment', 'system', 'progress']);
export const SUMMARY_TEXT_MAX = 4096;

/** The visible chain of a whole transcript (test aid and reference for the transcript reader): latest leaf, parent walk through
 *  compaction boundaries (logicalParentUuid), plus the parallel tool_result siblings of chain entries; file order. */
export function linearize(raw: readonly RawEntry[]): RawEntry[] {
  const chain = raw.filter((r) => typeof r.e['uuid'] === 'string' && CHAIN_TYPES.has(str(r.e['type'])) && r.e['isSidechain'] !== true);
  const byUuid = new Map<string, RawEntry>();
  const hasChild = new Set<string>();
  for (const r of chain) byUuid.set(str(r.e['uuid']), r);
  const parentOf = (e: Rec): string => str(e['parentUuid']) || str(e['logicalParentUuid']);
  for (const r of chain) { const p = parentOf(r.e); if (p && r.e['type'] !== 'progress') hasChild.add(p); }
  let leaf: RawEntry | undefined;
  for (let i = chain.length - 1; i >= 0 && !leaf; i--) {
    const r = chain[i]!;
    const t = r.e['type'];
    if ((t === 'user' || t === 'assistant') && !hasChild.has(str(r.e['uuid']))) leaf = r;
  }
  if (!leaf) return [];
  const keep = new Set<string>();
  for (let cur: RawEntry | undefined = leaf; cur && !keep.has(str(cur.e['uuid'])); cur = byUuid.get(parentOf(cur.e))) keep.add(str(cur.e['uuid']));
  return chain.filter((r) => {
    if (keep.has(str(r.e['uuid']))) return true;
    if (r.e['type'] !== 'user' || !arr(rec(r.e['message'])['content']).some((c) => rec(c)['type'] === 'tool_result')) return false;
    return keep.has(str(r.e['sourceToolAssistantUUID'])) || keep.has(parentOf(r.e));
  });
}

type TurnAcc = { turn: P.UiTurn; index: Map<string, number>; usage: Map<string, unknown>; models: string[]; durationMs?: number };

export const diskToTurns: DiskToTurns = (chain, o) => {
  void o;
  const turns: TurnAcc[] = [];
  const heavy: HeavyLoc[] = [];
  const toolAt = new Map<string, TurnAcc>();      // tool_use_id → turn holding the block
  const ordinal = new Map<string, number>();      // message.id → entries seen
  let acc: TurnAcc | null = null;

  const open = (head: P.UiTurnHead): TurnAcc => { acc = { turn: { ...head, blocks: [] }, index: new Map(), usage: new Map(), models: [] }; turns.push(acc); return acc; };
  const ensure = (id: string, at: number): TurnAcc => acc ?? open({ id, at, user: null });
  const put = (a: TurnAcc, b: P.UiBlock): void => {
    const i = a.index.get(b.id);
    if (i === undefined) { a.index.set(b.id, a.turn.blocks.length); a.turn.blocks.push(b); } else a.turn.blocks[i] = b;
  };
  const sysRow = (r: RawEntry, row: P.UiSystemRow): void => { const id = blockId('system', str(r.e['uuid'])); put(ensure(id, isoMs(r.e['timestamp'])), { k: 'system', id, row }); };
  const markCompaction = (): void => { for (const t of turns) if (t !== acc) t.turn.beforeCompaction = true; };

  for (const r of chain) {
    const e = r.e;
    if (e['isSidechain'] === true) continue;
    const type = str(e['type']);
    const uuid = str(e['uuid']);
    const at = isoMs(e['timestamp']);
    if (type === 'user') {
      if (e['isMeta'] === true) continue;
      const content = rec(e['message'])['content'];
      if (e['isCompactSummary'] === true) {
        sysRow(r, { kind: 'compact', text: cut(contentText(content), SUMMARY_TEXT_MAX), data: { summary: true } });
        markCompaction();
        continue;
      }
      let sawResult = false;
      for (const c of arr(content)) {
        const cb = rec(c);
        if (cb['type'] !== 'tool_result') continue;
        sawResult = true;
        const toolUseId = str(cb['tool_use_id']);
        const holder = toolAt.get(toolUseId);
        const id = blockId('tool', toolUseId);
        const i = holder?.index.get(id);
        const b = holder && i !== undefined ? holder.turn.blocks[i] : undefined;
        if (!holder || !b || b.k !== 'tool') continue;
        const lite = liteToolResult(b.name, toolUseId, { content: cb['content'], isError: cb['is_error'] === true, toolUseResult: e['toolUseResult'],
          denialKind: e['toolDenialKind'], decisionSource: rec(e['permissionDecision'])['source'] });
        for (const h of lite.heavy) heavy.push({ id: h.id, field: h.field, off: r.off, len: r.len });
        put(holder, { ...b, status: lite.status, result: lite.result });
      }
      if (sawResult) continue;
      const text = contentText(content);
      if (isInterruptText(text)) { sysRow(r, { kind: 'interrupted', text: text.trim() }); continue; }
      const id = blockId('user', uuid);
      const msg: P.UiUserMsg = { uuid, text, origin: userOrigin(e['origin'], text) };
      const imgs = contentImages(content);
      if (imgs.length) {
        msg.images = imageRefs(id, imgs);
        imgs.forEach((_, n) => heavy.push({ id: imageRefId(id, n), field: 'image', off: r.off, len: r.len }));
      }
      open({ id, at, user: msg });
      continue;
    }
    if (type === 'attachment') {
      const a = rec(e['attachment']);
      if (a['type'] !== 'queued_command') continue;
      const u = optStr(a['source_uuid']) ?? optStr(a['commandUuid']) ?? optStr(a['command_uuid']) ?? uuid;
      const text = typeof a['prompt'] === 'string' ? a['prompt'] : contentText(a['prompt']);
      const id = blockId('user', u);
      put(ensure(id, at), { k: 'user', id, msg: { uuid: u, text, origin: userOrigin(a['origin'], text), delivery: 'folded' } });
      continue;
    }
    if (type === 'assistant') {
      const m = rec(e['message']);
      const mid = str(m['id']);
      const model = str(m['model']);
      if (e['isApiErrorMessage'] === true || (optStr(e['error']) && (model === SYNTHETIC || !model))) {   // same rule as live-reducer.ts
        sysRow(r, { kind: 'error', text: contentText(m['content']), ...(typeof e['error'] === 'string' ? { data: { error: e['error'] } } : {}) });
        continue;
      }
      if (model === SYNTHETIC) { sysRow(r, localRow(m['content'], e['usage_report'] ?? m['usage_report'])); continue; }
      const ord = ordinal.get(mid) ?? 0;
      ordinal.set(mid, ord + 1);
      const base = num(e['apiBlockIndex']) ?? ord;
      const a = ensure(`x:${uuid}`, at);
      if (m['usage'] !== undefined) a.usage.set(mid, m['usage']);
      if (model && model !== '<synthetic>' && !a.models.includes(model)) a.models.push(model);
      arr(m['content']).forEach((c, k) => {
        const cb = rec(c);
        const ct = str(cb['type']);
        const idx = base + k;
        if (ct === 'text') put(a, { k: 'text', id: blockId('text', mid, idx), md: str(cb['text']), ...(model ? { model } : {}), ...(e['isAbortedMidStream'] === true ? { aborted: true } : {}) });
        else if (ct === 'thinking' || ct === 'redacted_thinking') {
          const id = blockId('thinking', mid, idx);
          const t = str(cb['thinking']);
          if (t) heavy.push({ id, field: 'thinking', off: r.off, len: r.len });
          put(a, { k: 'thinking', id, chars: t.length, ...(ct === 'redacted_thinking' ? { redacted: true } : {}) });
        } else if (ct === 'tool_use' || ct === 'server_tool_use' || ct === 'mcp_tool_use') {
          const toolUseId = str(cb['id']);
          const name = str(cb['name']);
          const id = blockId('tool', toolUseId);
          const input = toolInputView(name, rec(cb['input']));
          if (inputIsHeavy(input)) heavy.push({ id, field: 'input', off: r.off, len: r.len });
          put(a, { k: 'tool', id, toolUseId, name, input, status: 'running', ...(model ? { model } : {}) });
          toolAt.set(toolUseId, a);
        }
      });
      continue;
    }
    if (type === 'system') {
      const sub = str(e['subtype']);
      if (sub === 'compact_boundary') {
        const cm = rec(e['compactMetadata']);
        const data: Record<string, string | number | boolean> = { trigger: str(cm['trigger']) || 'auto' };
        for (const [k, v] of [['preTokens', cm['preTokens']], ['postTokens', cm['postTokens']], ['durationMs', cm['durationMs']]] as const) { const n = num(v); if (n !== undefined) data[k] = n; }
        sysRow(r, { kind: 'compact', data });
        markCompaction();
      } else if (sub === 'api_error') {
        const er = rec(e['error']);
        const data: Record<string, string | number | boolean> = { attempt: num(e['retryAttempt']) ?? 0, max: num(e['maxRetries']) ?? 0, inMs: num(e['retryInMs']) ?? 0 };
        const st = num(er['status']); if (st !== undefined) data['status'] = st;
        sysRow(r, { kind: 'retry', data });
      } else if (sub === 'local_command') sysRow(r, { kind: 'local', text: localCommandText(str(e['content'])) });
      else if (sub === 'model_refusal_fallback' || sub === 'model_refusal_no_fallback') sysRow(r, { kind: 'refusal', text: str(e['content']) || undefined, data: { fallback: sub === 'model_refusal_fallback' } });
      else if (sub === 'turn_duration' && acc) (acc as TurnAcc).durationMs = num(e['durationMs']);
    }
  }
  // footers (Σ usage per distinct message.id) and tools left without a result
  const out: P.UiTurn[] = [];
  turns.forEach((t, n) => {
    if (t.usage.size) { t.turn.footer = footerFromUsages(t.usage, t.models); if (t.durationMs !== undefined) t.turn.footer.durationMs = t.durationMs; }
    if (n < turns.length - 1 || o.closed) t.turn.blocks = t.turn.blocks.map((b) => (b.k === 'tool' && b.status === 'running' ? { ...b, status: 'interrupted' } : b));
    out.push(t.turn);
  });
  return { turns: out, heavy };
};

/** Serves a HeavyLoc: the heavy field of block `id` from its transcript line (read by the transcript reader at loc.off/len). */
export function detailFromEntry(e: Record<string, unknown>, id: string, field: P.DetailField): P.DetailPayload | null {
  if (field === 'raw') return { text: JSON.stringify(e) };
  const m = rec(e['message']);
  const content = m['content'];
  const hash = id.lastIndexOf('#');
  if (field === 'image') {
    const n = hash >= 0 ? Number(id.slice(hash + 1)) : 0;
    const owner = hash >= 0 ? id.slice(0, hash) : id;
    let src: unknown = content;
    if (owner.startsWith('t:')) src = rec(arr(content).find((c) => rec(c)['type'] === 'tool_result' && `t:${str(rec(c)['tool_use_id'])}` === owner))['content'];
    const im = contentImages(src)[n];
    return im ? { dataUrl: `data:${im.mediaType};base64,${im.base64}`, mediaType: im.mediaType } : null;
  }
  if (field === 'thinking') {
    const t = arr(content).map(rec).find((c) => c['type'] === 'thinking');
    return t ? { text: str(t['thinking']) } : null;
  }
  if (field === 'input') {
    const t = arr(content).map(rec).find((c) => `t:${str(c['id'])}` === id);
    return t ? { text: JSON.stringify(t['input'] ?? {}) } : null;
  }
  const tur = rec(e['toolUseResult']);
  if (field === 'originalFile') return typeof tur['originalFile'] === 'string' ? { text: tur['originalFile'] } : null;
  if (field === 'output') {
    const tr = arr(content).map(rec).find((c) => c['type'] === 'tool_result' && `t:${str(c['tool_use_id'])}` === id);
    if (!tr) return null;
    return { text: typeof tur['stdout'] === 'string' ? tur['stdout'] : contentText(tr['content']) };
  }
  return null;
}
