import WebSocket from 'ws';

// Companion 5.x edits over tRPC (server v11) on ws://<host>/trpc,
// with no transformer, so inputs and results are plain JSON. A Node client
// sends no browser Origin, which Companion's Origin check lets through.

const TIMEOUT_MS = 8000;

export type ProcedureKind = 'query' | 'mutation' | 'subscription';

// An error Companion answered with, carrying tRPC's code (NOT_FOUND, ...).
export type TrpcError = Error & { code: string };

const trpcError = (path: string, message: string, code: string): TrpcError =>
    Object.assign(new Error(`Companion: ${path}: ${message}`), { code });

export class TrpcSession {
    private ws: WebSocket;

    private nextId = 0;

    private waiting = new Map<number, (_m: any) => void>();

    // Long-lived subscriptions (preview images): unlike `waiting`, a hit
    // here is never deleted after one message - every value the
    // subscription ever emits goes to the same callback, until `subscribe`'s
    // returned stop function removes it.
    private subs = new Map<number, (_m: any) => void>();

    private constructor(ws: WebSocket) {
        this.ws = ws;
        ws.on('message', (data) => {
            // Companion's keep-alive; 5.1.2 drops a client that stays quiet.
            if (String(data) === 'PING') {
                ws.send('PONG');
                return;
            }
            let m: any;
            try {
                m = JSON.parse(String(data));
            } catch {
                return; // not a tRPC frame
            }
            // A subscription answers "started" before its first data.
            if (m.result?.type === 'started') return;
            const subCb = this.subs.get(m?.id);
            if (subCb) {
                subCb(m);
                return;
            }
            const cb = this.waiting.get(m?.id);
            if (!cb) return;
            this.waiting.delete(m.id);
            cb(m);
        });
    }

    static open(baseUrl: string): Promise<TrpcSession> {
        const url = `${baseUrl.replace(/^http/, 'ws')}/trpc`;
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url);
            const timer = setTimeout(() => {
                ws.terminate();
                reject(new Error('Companion did not answer'));
            }, TIMEOUT_MS);
            ws.once('open', () => {
                clearTimeout(timer);
                resolve(new TrpcSession(ws));
            });
            ws.once('error', (e) => {
                clearTimeout(timer);
                reject(e);
            });
        });
    }

    private send(
        method: ProcedureKind,
        path: string,
        input: unknown
    ): Promise<any> {
        this.nextId += 1;
        const id = this.nextId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiting.delete(id);
                reject(new Error(`Companion: ${path} timed out`));
            }, TIMEOUT_MS);
            this.waiting.set(id, (m) => {
                clearTimeout(timer);
                if (m.error) {
                    reject(
                        trpcError(
                            path,
                            m.error.message ?? JSON.stringify(m.error),
                            m.error.data?.code ?? String(m.error.code ?? '')
                        )
                    );
                } else {
                    resolve(m.result?.data);
                }
            });
            this.ws.send(
                JSON.stringify({ id, method, params: { path, input } })
            );
            if (method === 'subscription') {
                // Only the first value is wanted; stop once it arrives.
                const stop = this.waiting.get(id)!;
                this.waiting.set(id, (m) => {
                    this.ws.send(
                        JSON.stringify({ id, method: 'subscription.stop' })
                    );
                    stop(m);
                });
            }
        });
    }

    query(path: string, input: unknown) {
        return this.send('query', path, input);
    }

    mutate(path: string, input: unknown) {
        return this.send('mutation', path, input);
    }

    first(path: string, input: unknown) {
        return this.send('subscription', path, input);
    }

    // A subscription kept open for every value it emits (preview images),
    // unlike `first`'s one-shot read. Returns a function that stops it.
    subscribe(
        path: string,
        input: unknown,
        onData: (_d: any) => void,
        onError: (_e: TrpcError) => void
    ): () => void {
        this.nextId += 1;
        const id = this.nextId;
        this.subs.set(id, (m) => {
            if (m.error) {
                this.subs.delete(id);
                onError(
                    trpcError(
                        path,
                        m.error.message ?? JSON.stringify(m.error),
                        m.error.data?.code ?? String(m.error.code ?? '')
                    )
                );
                return;
            }
            onData(m.result?.data);
        });
        this.ws.send(
            JSON.stringify({
                id,
                method: 'subscription',
                params: { path, input },
            })
        );
        return () => {
            if (!this.subs.delete(id)) return;
            this.ws.send(JSON.stringify({ id, method: 'subscription.stop' }));
        };
    }

    // Whether a procedure of this kind exists, without running it. tRPC looks
    // the path up before it parses the input, so a missing procedure answers
    // NOT_FOUND and an existing one rejects the deliberately invalid input
    // with BAD_REQUEST. The input given here must fail every schema the
    // procedure could have (see PROBE_INPUT); a procedure that takes no input
    // must never be probed this way.
    async has(kind: ProcedureKind, path: string): Promise<boolean> {
        try {
            await this.send(kind, path, PROBE_INPUT);
        } catch (e) {
            const { code } = e as Partial<TrpcError>;
            // A timeout or a closed socket has no code and is not an answer.
            if (typeof code !== 'string') throw e;
            return code !== 'NOT_FOUND';
        }
        // It ran: the input did not stop it. Treat as present, but this
        // means the probe input is wrong for this procedure.
        return true;
    }

    close() {
        this.ws.close();
    }
}

// A bare string is rejected by every z.object() input schema, and no
// procedure Companion's editor uses takes a string as its whole input.
export const PROBE_INPUT = '__fimav_probe__';
