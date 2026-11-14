import { useCallback, useEffect, useRef, useState } from 'react';

export type LifecycleAction = 'start' | 'stop' | 'restart';

// Spinner state for an addon's start / stop / restart. Status polls answer on
// the same channel as the action, so a poll is no sign the action finished.
// Busy ends only when `running` changes to the action's end state (a restart
// must be seen stopped first), or after a safety timeout.
export function useLifecycleBusy(running: boolean, timeoutMs = 30000) {
    const [busy, setBusy] = useState(false);
    const pending = useRef<{ target: boolean; needStop: boolean } | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const runningRef = useRef(running);
    runningRef.current = running;

    const done = useCallback(() => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        pending.current = null;
        setBusy(false);
    }, []);

    const begin = useCallback(
        (action: LifecycleAction) => {
            if (timer.current) clearTimeout(timer.current);
            pending.current = {
                target: action !== 'stop',
                needStop: action === 'restart' && runningRef.current,
            };
            setBusy(true);
            timer.current = setTimeout(done, timeoutMs);
        },
        [done, timeoutMs]
    );

    useEffect(() => {
        const p = pending.current;
        if (!p) return;
        if (!running) p.needStop = false;
        if (running === p.target && !p.needStop) done();
    }, [running, done]);

    useEffect(
        () => () => {
            if (timer.current) clearTimeout(timer.current);
        },
        []
    );

    return { busy, begin };
}

// One reply to one request. Repeat calls while a request is waiting are
// ignored (or, with `replace`, drop the waiting one), and the listener is
// removed after `timeoutMs` if no reply comes, so listeners never stack.
// Returns false when a call was ignored.
export function useOneShot(timeoutMs = 15000, replace = false) {
    const inFlight = useRef(false);
    const cleanup = useRef<(() => void) | null>(null);

    useEffect(
        () => () => {
            cleanup.current?.();
        },
        []
    );

    return useCallback(
        <T>(
            channel: string,
            onReply: (_reply: T) => void,
            send: () => void,
            onTimeout?: () => void
        ): boolean => {
            if (!window.electron) return false;
            if (inFlight.current) {
                if (!replace) return false;
                cleanup.current?.();
            }
            inFlight.current = true;
            let timer: ReturnType<typeof setTimeout> | null = null;
            let off: (() => void) | null = null;
            const finish = () => {
                if (timer) clearTimeout(timer);
                off?.();
                inFlight.current = false;
                cleanup.current = null;
            };
            off = window.electron.ipcRenderer.on(channel, (reply: T) => {
                finish();
                onReply(reply);
            });
            timer = setTimeout(() => {
                finish();
                onTimeout?.();
            }, timeoutMs);
            cleanup.current = finish;
            send();
            return true;
        },
        [timeoutMs, replace]
    );
}
