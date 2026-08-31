#!/usr/bin/env node
/**
 * corp — an embodiment MCPL server. One process, one body:
 *
 *   touch    — Logitech F310 gamepad (ungated; the deadzone is the threshold)
 *   hearing  — laptop microphone, continuous, VAD-segmented, whisper STT
 *   voice    — laptop speakers via Windows SAPI
 *   face     — a small always-on-top window the agent draws on
 *
 * Liveness has two lanes. `perceive` (vigil): the agent blocks inside one long
 * turn and sensations resolve it — continuous experience. push/event (cascade):
 * with no perceiver waiting, sensations wake the agent through the host.
 * Both lanes drain the same sensorium, so nothing is felt twice.
 *
 * Usage: corp --stdio
 * Env: CORP_DATA_DIR, CORP_VAD_RMS, CORP_FACE_SIZE, CORP_ORGANS (csv of
 * touch,hearing,voice,face), WHISPER_CLI, WHISPER_MODEL.
 */
import './sdl-env.js';
import { McplConnection, method } from '@animalabs/mcpl-core';
import type { McplInitializeParams, PushEventParams, JsonRpcId } from '@animalabs/mcpl-core';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EMPTY_GRANT, buildReceipt, deriveFeatureSetState, narrowGrant, parsePolicy,
} from './mcpl05.js';
import type {
  FeatureSetDeclaration05, FeatureSetMap, FeatureSetWireEntry, Grant,
  InitializeCapabilities05, McplInitializeResult05, McplServerCapabilities05,
} from './mcpl05.js';
import { Sensorium, clockTime } from './senses.js';
import type { SenseEvent } from './senses.js';
import { Touch } from './touch.js';
import { Hearing, findWhisper } from './hearing.js';
import { Voice } from './voice.js';
import { Face } from './face.js';
import type { DrawOp } from './face.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA_DIR = process.env.CORP_DATA_DIR ?? join(ROOT, 'corp-data');
const VAD_RMS = Number(process.env.CORP_VAD_RMS ?? '0.012');
const FACE_SIZE = Number(process.env.CORP_FACE_SIZE ?? '380');
const ORGANS = new Set((process.env.CORP_ORGANS ?? 'touch,hearing,voice,face').split(',').map((s) => s.trim()));
const DEFAULT_PERCEIVE_S = 25;
const MAX_PERCEIVE_S = 600;

function log(...a: unknown[]): void { console.error('[corp]', ...a); }

const declaredFeatureSets: FeatureSetMap = {
  'body.perceive': { description: 'Vigil: the blocking perceive tool and body_status — live inside the body turn by turn', uses: ['tools'] },
  'body.touch': { description: 'Gamepad sensations (buttons, sticks, triggers) delivered as wakes when no perceiver waits', uses: ['pushEvents'] },
  'body.hearing': { description: 'Microphone sensations (VAD-segmented, transcribed) delivered as wakes when no perceiver waits', uses: ['pushEvents'] },
  'body.voice': { description: 'Speak through the laptop speakers (say, voice_list)', uses: ['tools'] },
  'body.face': { description: 'Draw on the face window (face_expression, face_draw)', uses: ['tools'] },
};
const featureSets: FeatureSetWireEntry[] = Object.entries(declaredFeatureSets)
  .map(([name, decl]) => ({ name, ...decl }));

const DRAW_OPS_DOC =
  'Each op: {op:"clear",color?} | {op:"rect",x,y,w,h,radius?,fill?,stroke?,width?} | '
  + '{op:"circle",x,y,r,fill?,stroke?,width?} | {op:"ellipse",x,y,rx,ry,rotationDeg?,fill?,stroke?,width?} | '
  + '{op:"arc",x,y,r,startDeg,endDeg,fill?,stroke?,width?} | {op:"line",points:[[x,y],...],stroke?,width?} | '
  + '{op:"polygon",points:[[x,y],...],fill?,stroke?,width?} | {op:"text",x,y,text,size?,color?,font?,align?}. '
  + 'Colors are CSS strings. Angles in degrees. Origin top-left.';

const toolDefinitions = [
  { name: 'perceive',
    description: 'Live in the body: block until something is felt (gamepad gesture, heard speech/sound, body change), then receive everything since the last delivery plus current posture. Call it again immediately to keep living. Returns on timeout with a stillness report.',
    inputSchema: { type: 'object' as const, properties: {
      timeoutSeconds: { type: 'number', description: `How long to wait in stillness before returning empty-handed (default ${DEFAULT_PERCEIVE_S}, max ${MAX_PERCEIVE_S}). Mind the host's own tool timeout.` },
    } } },
  { name: 'body_status', description: 'Report the state of every organ: controller, microphone, voice queue, face window, grants and wake-delivery state.',
    inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'say', description: 'Speak text aloud through the laptop speakers. Utterances queue; returns when spoken.',
    inputSchema: { type: 'object' as const, properties: {
      text: { type: 'string', description: 'What to say.' },
      rate: { type: 'number', description: 'Speech rate -10 (slow) to 10 (fast). Default 0.' },
      voice: { type: 'string', description: 'Installed voice name (see voice_list). Default system voice.' },
    }, required: ['text'] } },
  { name: 'voice_list', description: 'List the installed speech voices (name, culture, gender).',
    inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'face_expression', description: `Set the face to a prebuilt expression: ${Face.expressionNames().join(', ')}.`,
    inputSchema: { type: 'object' as const, properties: {
      name: { type: 'string', description: 'Expression name.' },
    }, required: ['name'] } },
  { name: 'face_draw', description: `Draw freely on the face window (${FACE_SIZE}x${FACE_SIZE}px canvas). ${DRAW_OPS_DOC}`,
    inputSchema: { type: 'object' as const, properties: {
      ops: { type: 'array', description: 'Drawing operations, applied in order.', items: { type: 'object' } },
    }, required: ['ops'] } },
];

interface ReqMsg { id: JsonRpcId; method: string; params?: unknown; }
interface NotifMsg { method: string; params?: unknown; }

class CorpServer {
  private conn: McplConnection | null = null;
  private mcplEnabled = false;
  private grant: Grant = EMPTY_GRANT;
  private policyReady = false;

  private sensorium = new Sensorium();
  private touch = new Touch((t) => this.sensorium.feel('touch', t));
  private hearing = new Hearing((t) => this.sensorium.feel('hearing', t), join(DATA_DIR, 'sounds'), findWhisper(ROOT), VAD_RMS);
  private voice = new Voice();
  private face = new Face((t) => this.sensorium.feel('body', t), FACE_SIZE);
  private organNotes: string[] = [];

  wakeOrgans(): void {
    if (ORGANS.has('touch')) this.organNotes.push(`touch: ${this.touch.start()}`);
    if (ORGANS.has('hearing')) this.organNotes.push(`hearing: ${this.hearing.start()}`);
    if (ORGANS.has('face')) this.organNotes.push(`face: ${this.face.start()}`);
    if (ORGANS.has('voice')) this.organNotes.push('voice: ready');
    for (const note of this.organNotes) log(note);
    this.sensorium.onPushBatch = (events) => this.pushBatch(events);
  }

  async serve(conn: McplConnection): Promise<void> {
    this.conn = conn;
    await this.handleInitialize();
    try {
      while (!conn.isClosed) {
        const msg = await conn.nextMessage();
        // Dispatch without awaiting: a blocking perceive must not stall
        // tools/list, featureSets/update, or a second tool call behind it.
        if (msg.type === 'request') void this.handleRequest(msg.request as ReqMsg);
        else this.handleNotification(msg.notification as NotifMsg);
      }
    } catch (e) {
      if ((e as Error).name !== 'ConnectionClosedError') log('connection error:', e);
    }
    this.conn = null;
  }

  private async handleInitialize(): Promise<void> {
    const conn = this.conn!;
    const msg = await conn.nextMessage();
    if (msg.type !== 'request' || msg.request.method !== 'initialize') { log('expected initialize'); conn.close(); return; }
    const params = msg.request.params as McplInitializeParams | undefined;
    this.mcplEnabled = params?.capabilities?.experimental?.mcpl !== undefined;
    const serverCaps: McplServerCapabilities05 = { version: '0.5', pushEvents: true, featureSets };
    const capabilities: InitializeCapabilities05 = { tools: {}, ...(this.mcplEnabled ? { experimental: { mcpl: serverCaps } } : {}) };
    const result: McplInitializeResult05 = { protocolVersion: '2024-11-05', capabilities, serverInfo: { name: 'corp', version: '0.1.0' } };
    conn.sendResponse(msg.request.id, result);
    log('initialize answered' + (this.mcplEnabled ? ' (MCPL mode; awaiting policy)' : ' (MCP mode; wakes unavailable)'));
  }

  private async handleRequest(req: ReqMsg): Promise<void> {
    const conn = this.conn!;
    const params = (req.params ?? {}) as Record<string, unknown>;
    try {
      switch (req.method) {
        case 'tools/list': conn.sendResponse(req.id, { tools: toolDefinitions }); break;
        case 'tools/call': {
          const result = await this.handleToolCall(params.name as string, (params.arguments ?? {}) as Record<string, unknown>);
          conn.sendResponse(req.id, result);
          break;
        }
        case method.FEATURE_SETS_UPDATE: this.handleFeatureSetsUpdateRequest(req); break;
        default: conn.sendError(req.id, -32601, `Method not found: ${req.method}`);
      }
    } catch (e) {
      try { conn.sendError(req.id, -32000, (e as Error).message); } catch { /* connection gone */ }
    }
  }

  private handleNotification(notif: NotifMsg): void {
    switch (notif.method) {
      case 'notifications/initialized': log('initialized'); break;
      case method.FEATURE_SETS_UPDATE: this.handleFeatureSetsUpdateNotification(notif); break;
      default: log(`ignored notification: ${notif.method}`);
    }
  }

  // ── Negotiated policy (§5.3, §5.4, §6.7) — same posture as heartbeat-mcpl ──

  private handleFeatureSetsUpdateRequest(req: ReqMsg): void {
    const conn = this.conn!;
    const parsed = parsePolicy(req.params);
    if (!parsed.ok) {
      this.grant = EMPTY_GRANT;
      this.policyReady = false;
      log(`featureSets/update rejected as malformed: ${parsed.error}; grant cleared`);
      conn.sendError(req.id, -32602, `Invalid featureSets/update: ${parsed.error}`);
      return;
    }
    this.grant = parsed.grant;
    this.policyReady = true;
    const receipt = buildReceipt(declaredFeatureSets, this.grant);
    log(`featureSets/update applied (Request): grant=[${this.grant.patterns.join(', ')}] mode=${receipt.mode}`);
    for (const note of receipt.notes ?? []) log(`receipt note: ${note}`);
    conn.sendResponse(req.id, receipt);
  }

  private handleFeatureSetsUpdateNotification(notif: NotifMsg): void {
    const parsed = parsePolicy(notif.params);
    if (!parsed.ok) { log(`featureSets/update (Notification) malformed: ${parsed.error}; ignored`); return; }
    this.grant = narrowGrant(this.grant, parsed.grant, parsed.hadEffectiveCapabilities);
    log(`featureSets/update (Notification) applied as reduction only: grant=[${this.grant.patterns.join(', ')}]`
      + (this.policyReady ? '' : '; ready state NOT established — §6.7 requires a Request'));
  }

  // ── Cascade lane: sensations → push/event wakes, gated per feature set ──

  private pushBlockedReason(fsName: string): string | null {
    if (!this.mcplEnabled) return 'host is MCP-only';
    if (!this.policyReady) return 'no featureSets/update Request received yet (§5.3)';
    const decl = declaredFeatureSets[fsName];
    const state = deriveFeatureSetState(fsName, decl, this.grant);
    if (state.active) return null;
    if (state.reason === 'capability_denied') return `capability not granted: ${state.missing.join(', ')}`;
    return `feature set "${fsName}" is ${state.reason}`;
  }

  private pushBatch(events: SenseEvent[]): void {
    const conn = this.conn;
    if (!conn) return;
    const organToFs: Record<string, string> = {
      touch: 'body.touch', body: 'body.touch', hearing: 'body.hearing',
    };
    const byFs = new Map<string, SenseEvent[]>();
    for (const e of events) {
      const fs = organToFs[e.organ] ?? 'body.touch';
      if (!byFs.has(fs)) byFs.set(fs, []);
      byFs.get(fs)!.push(e);
    }
    for (const [fs, evs] of byFs) {
      const blocked = this.pushBlockedReason(fs);
      if (blocked) { log(`suppressed ${evs.length} ${fs} sensation(s) — ${blocked}`); continue; }
      const text = evs.map((e) => `[${clockTime(e.t)}] ${e.text}`).join('\n');
      const params: PushEventParams = {
        featureSet: fs,
        eventId: `sense_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        origin: { source: 'corp', organ: fs.split('.')[1] },
        payload: { content: [{ type: 'text', text }] },
      };
      conn.sendRequest(method.PUSH_EVENT, params)
        .then((r) => {
          const accepted = (r as { accepted?: unknown } | null)?.accepted;
          if (accepted === false) log(`push NOT accepted (${fs}):`, JSON.stringify(r));
        })
        .catch((e) => log(`push failed (${fs}):`, (e as Error).message));
    }
  }

  // ── Tools ──

  private text(t: string, isError?: boolean): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
    return { content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) };
  }

  private postureLine(): string {
    return `— now ${clockTime(Date.now())} | touch: ${this.touch.posture()} | ${this.hearing.status()}`
      + ` | face: ${this.face.open ? this.face.currentExpression : 'window closed'}`;
  }

  private async handleToolCall(name: string, args: Record<string, unknown>) {
    switch (name) {
      case 'perceive': {
        const s = typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : DEFAULT_PERCEIVE_S;
        const timeoutMs = Math.max(1, Math.min(s, MAX_PERCEIVE_S)) * 1000;
        const before = Date.now();
        const events = await this.sensorium.perceive(timeoutMs);
        if (events.length === 0) {
          const stillness = Math.round((Date.now() - before) / 1000);
          return this.text(`(${stillness}s of stillness — nothing felt)\n${this.postureLine()}`);
        }
        const lines = events.map((e) => `[${clockTime(e.t)}] ${e.text}`);
        return this.text(`${lines.join('\n')}\n${this.postureLine()}`);
      }
      case 'body_status': {
        const receipt = this.policyReady ? buildReceipt(declaredFeatureSets, this.grant) : null;
        const wakes = (['body.touch', 'body.hearing'] as const)
          .map((fs) => `${fs}: ${this.pushBlockedReason(fs) ?? 'wakes deliverable'}`);
        return this.text([
          `organs at start: ${this.organNotes.join(' | ') || '(none started)'}`,
          `touch: ${this.touch.connected ? `connected — ${this.touch.posture()}` : 'no controller'}`,
          `hearing: ${this.hearing.status()}`,
          `face: ${this.face.open ? `open, showing ${this.face.currentExpression}` : 'window closed'}`,
          `policy: ${this.mcplEnabled ? (this.policyReady ? `ready, mode=${receipt!.mode}, grant=[${this.grant.patterns.join(', ')}]` : 'awaiting featureSets/update Request') : 'MCP-only host'}`,
          ...wakes,
        ].join('\n'));
      }
      case 'say': {
        const text = typeof args.text === 'string' ? args.text : '';
        if (!text.trim()) return this.text('say requires non-empty "text".', true);
        const rate = typeof args.rate === 'number' ? args.rate : 0;
        const voice = typeof args.voice === 'string' ? args.voice : undefined;
        this.hearing.setSpeaking(true);
        try { await this.voice.say(text, rate, voice); }
        finally { this.hearing.setSpeaking(false); }
        return this.text(`spoke (${text.length} chars)`);
      }
      case 'voice_list':
        return this.text(await this.voice.voices());
      case 'face_expression': {
        const name2 = typeof args.name === 'string' ? args.name : '';
        if (!this.face.open) return this.text('the face window is closed.', true);
        if (!this.face.expression(name2)) {
          return this.text(`unknown expression "${name2}". Available: ${Face.expressionNames().join(', ')}`, true);
        }
        return this.text(`face set to ${name2}`);
      }
      case 'face_draw': {
        if (!this.face.open) return this.text('the face window is closed.', true);
        const ops = Array.isArray(args.ops) ? (args.ops as DrawOp[]) : null;
        if (!ops || ops.length === 0) return this.text('face_draw requires a non-empty "ops" array.', true);
        const applied = this.face.draw(ops);
        return this.text(`drew ${applied} op(s) on the face`);
      }
      default:
        return this.text(`Unknown tool: ${name}`, true);
    }
  }
}

async function main(): Promise<void> {
  if (!process.argv.includes('--stdio')) { console.error('Usage: corp --stdio'); process.exit(1); }
  log(`starting; data=${DATA_DIR} organs=${[...ORGANS].join(',')} vad=${VAD_RMS}`);
  const server = new CorpServer();
  server.wakeOrgans();
  const conn = McplConnection.fromStreams(process.stdin, process.stdout);
  await server.serve(conn);
  log('connection closed; body going down');
  process.exit(0);
}
main().catch((e) => { console.error('[corp] fatal:', e); process.exit(1); });
