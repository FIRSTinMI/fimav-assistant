// Stream and audio checks (src/main/checks/engine.ts), shared with the UI.
export type CheckState = 'ok' | 'warning' | 'critical' | 'unknown';

export interface CheckResult {
    id: string;
    group:
        | 'Hardware'
        | 'Stream'
        | 'Audio'
        | 'Recording'
        | 'Captions'
        | 'Display';
    label: string;
    state: CheckState;
    detail: string;
    // Why the problem matters, shown on hover over the detail.
    hint: string | null;
    // docs.fimav.us page that explains how to put it right.
    doc: string | null;
    // Label of a one-click fix the app can do for the current problem.
    fix: string | null;
    // Set while "Ignore" (6 h) is in force for this check (epoch ms).
    ignoredUntil: number | null;
}

// Failing and not ignored: what the banner, the menu count and the Windows
// notification show. Hardware is list only: the status bar already shows it.
export const isAlerting = (r: CheckResult) =>
    (r.state === 'warning' || r.state === 'critical') &&
    !r.ignoredUntil &&
    r.group !== 'Hardware';
