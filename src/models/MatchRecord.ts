import { TournamentLevel } from './FMSMatchState';

// A single team's participation in a recorded match, including any card issued
export interface MatchTeam {
    teamNumber: number;
    // Team nickname as FMS has it (trimmed); null when FMS gave none.
    // Absent on records written before names were captured.
    teamName?: string | null;
    // Effective card for THIS match (from FMS cardEffectiveStatus). A carried
    // yellow from a previous match is not reflected here (see FmsApi).
    card: 'None' | 'Yellow' | 'Red';
}

export type MatchRecordStatus = 'recording' | 'recorded' | 'error';

// Reserved for the v2 cutting step. Not populated yet.
export interface MatchProcessing {
    state: 'unprocessed' | 'queued' | 'processing' | 'done' | 'error';
    outputPath?: string;
    // Where the cut moved the raw recording (Originals/, possibly "X (2).mp4"),
    // so recovery after a restart puts back exactly that file.
    originalPath?: string;
    error?: string;
}

// The video's loudness over the 400 ms blocks in which a mic was live
// (src/main/checks/loudness.ts).
export interface MatchTalkLoudness {
    // The mic levels were read during this video at all.
    heard: boolean;
    // Seconds of talking in the video.
    seconds: number;
    // Gated loudness (LUFS) of those blocks; null under 3 s of talking, or
    // when the video was silent the whole time someone talked.
    lufs: number | null;
}

// Everything AutoAV knows about a match it recorded. Persisted to the
// 'recordings' store and surfaced in the Auto AV tab.
export interface MatchRecord {
    id: string; // `${level}_${matchNumber}_${playNumber}_${startedAt}`
    level: TournamentLevel;
    matchNumber: number;
    playNumber: number;
    eventName: string;
    eventCode: string | null;
    fileName: string | null;
    filePath: string | null;
    saveFolder: string | null;
    startedAt: number; // epoch ms (record start)
    endedAt: number | null; // epoch ms (record stop)
    status: MatchRecordStatus;
    error?: string;

    // v2 metadata (captured now, after the file is renamed)
    teams?: { red: MatchTeam[]; blue: MatchTeam[] };
    hasCard?: boolean; // derived: any cardEffectiveStatus !== 'None'
    // Final alliance totals from FMS results; absent when FMS gave none.
    score?: { red: number; blue: number } | null;

    // v2 processing (reserved, not populated this session)
    processing?: MatchProcessing;

    // Loudness of the final video's audio (the stream's Bus A mix), measured
    // with ffmpeg's ebur128 once the video is final: integrated LUFS and true
    // peak in dBTP, and the loudness while someone talked on the mics (absent
    // on records measured before that existed).
    loudness?: {
        lufs: number;
        truePeak: number | null;
        talk?: MatchTalkLoudness;
    };

    // FTC matches: FTC Live's short name and field. Their video is made by the
    // FTC recorder (src/main/ftc/recorder.ts), not cut from one recording.
    ftc?: { shortName: string; field: number };

    // Owned by the youtube-tba-upload process, never written by FIM-AV. Present
    // so the match store preserves it verbatim through a read-modify-write of the
    // shared manifest instead of dropping it. See matchStore's locked writes.
    upload?: unknown;
}
