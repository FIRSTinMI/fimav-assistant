// FTC Live (FTC scoring system) shapes shared by the main process and the UI.

// updateType values of FTC Live's /api/v2/stream/ websocket (8.0 / BIOBUZZ;
// 7.5 also had SHOW_RANDOM, dropped in 8.0).
export const FTC_UPDATE_TYPES = [
    'MATCH_LOAD',
    'MATCH_START',
    'MATCH_ABORT',
    'MATCH_COMMIT',
    'MATCH_POST',
    'SHOW_PREVIEW',
    'SHOW_MATCH',
] as const;

export type FtcUpdateType = (typeof FTC_UPDATE_TYPES)[number];

export const FTC_UPDATE_LABELS: Record<FtcUpdateType, string> = {
    MATCH_LOAD: 'Match Load',
    MATCH_START: 'Match Start',
    MATCH_ABORT: 'Match Abort',
    MATCH_COMMIT: 'Match Commit',
    MATCH_POST: 'Match Post',
    SHOW_PREVIEW: 'Show Preview',
    SHOW_MATCH: 'Show Match',
};

export interface FtcUpdate {
    type: FtcUpdateType;
    time: number;
    number: number;
    shortName: string;
    field: number;
    // MATCH_POST only (FTC Live's ApiV2UpdateMatchResultsPayload); undefined
    // on every other type.
    redScore?: number;
    blueScore?: number;
}

export interface FtcScorekeeperStatus {
    // host or host:port, '' when not set
    address: string;
    connected: boolean;
    eventCode: string | null;
    eventName: string | null;
    eventType: string | null;
    fieldCount: number;
    lastUpdate: FtcUpdate | null;
    error: string | null;
    // Scorekeepers the last scan found (manual or automatic).
    found: string[];
}

// Bitfocus triggers: "<updateType>:<field>" -> Companion button location.
export type FtcTriggerMap = Record<
    string,
    { page: number; row: number; column: number }
>;

export interface FtcSettings {
    address: string;
    eventCode: string;
    automations: boolean;
    triggers: FtcTriggerMap;
    matchSeconds: number;
    tailSeconds: number;
}
