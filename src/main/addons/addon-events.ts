import { EventEmitter } from 'events';
import log from 'electron-log';
import AddonPhaseTracker from './addon-phase';

// The optional event channel the downloaded add-ons serve on their own
// HTTP port (protocol 1): GET /api/events is a server-sent event stream of
// JSON messages, `{"type":"hello", ...full state}` first, then one message
// per change, with ": ping" comments every 15 s. An add-on run on its own
// simply has no subscriber.
//
// Subscribed only while the add-on's phase is 'running'; a dropped stream
// is retried every 3 s while it stays running.

export type AddonMessage = { type: string; [key: string]: unknown };

export default class AddonEvents extends EventEmitter {
    // Latest message of each type (hello included), for a status read.
    public readonly latest = new Map<string, AddonMessage>();

    public connected = false;

    private abort: AbortController | null = null;

    private retry: ReturnType<typeof setTimeout> | null = null;

    private readonly name: string;

    private readonly url: string;

    constructor(name: string, url: string, phase: AddonPhaseTracker) {
        super();
        this.name = name;
        this.url = url;
        phase.on('phase', (p) => {
            if (p === 'running') this.connect();
            else this.disconnect();
        });
        if (phase.get() === 'running') this.connect();
    }

    private disconnect() {
        if (this.retry) clearTimeout(this.retry);
        this.retry = null;
        this.abort?.abort();
        this.abort = null;
        if (this.connected) {
            this.connected = false;
            this.emit('connection', false);
        }
    }

    private connect() {
        this.disconnect();
        const abort = new AbortController();
        this.abort = abort;
        this.run(abort).catch(() => undefined);
    }

    private async run(abort: AbortController) {
        try {
            const rsp = await fetch(this.url, {
                headers: { accept: 'text/event-stream' },
                signal: abort.signal,
            });
            if (!rsp.ok || !rsp.body) throw new Error(`HTTP ${rsp.status}`);
            this.connected = true;
            this.emit('connection', true);
            const reader = rsp.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            for (;;) {
                // eslint-disable-next-line no-await-in-loop
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const blocks = buffer.split(/\r?\n\r?\n/);
                buffer = blocks.pop() ?? '';
                blocks.forEach((b) => this.onBlock(b));
            }
            throw new Error('stream ended');
        } catch (e) {
            if (abort.signal.aborted) return;
            if (this.connected) {
                this.connected = false;
                this.emit('connection', false);
            }
            log.debug(`${this.name} events: ${(e as Error).message}`);
            this.retry = setTimeout(() => {
                if (this.abort === abort) this.connect();
            }, 3000);
        }
    }

    // One SSE block: only `data:` lines matter; comments (": ping") skip.
    private onBlock(block: string) {
        const data = block
            .split(/\r?\n/)
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart())
            .join('\n');
        if (!data) return;
        try {
            const msg = JSON.parse(data) as AddonMessage;
            if (!msg || typeof msg.type !== 'string') return;
            this.latest.set(msg.type, msg);
            this.emit('message', msg);
            this.emit(msg.type, msg);
        } catch {
            log.debug(`${this.name} events: bad message`);
        }
    }
}
