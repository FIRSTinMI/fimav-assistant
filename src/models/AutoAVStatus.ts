import { FileNameMode } from '../utils/recording';

// Which FIRST program the cart is serving.
export type Program = 'frc' | 'ftc';

// Snapshot of AutoAV's health, surfaced in the Auto AV tab so a volunteer can
// tell at a glance whether recording is actually working.
export interface AutoAVStatus {
    // Whether the AutoAV addon thread is running
    running: boolean;
    // Connected to the FMS SignalR hub
    fmsConnected: boolean;
    // Connected to the FTC Live scorekeeper stream
    ftcConnected: boolean;
    // FRC or FTC: the Settings override, else what was detected (FTC when only
    // the scorekeeper answers, FRC otherwise). The app shows only that
    // program's features.
    program: Program;
    // What detection alone says, or null when neither answers
    programDetected: Program | null;
    // FRC off-season audience display (Settings): the official FMS display or
    // our custom one. In-season it is always the FMS display.
    frcAudienceDisplay: 'fms' | 'customAd';
    // The audience display in use now (what the vMix tab's button adds):
    // FTC Live's at FTC events, the custom one when the off-season setting
    // picks it, otherwise FMS.
    audienceDisplay: 'ftcLive' | 'fms' | 'customAd';
    // vMix reachability + whether it is currently recording
    vmix: { reachable: boolean; recording: boolean };
    // Whether AutoAV itself kicked off the current recording
    recordingActive: boolean;
    // The event AutoAV detected as currently running
    currentEvent: { name: string; code: string | null } | null;
    // Folder recordings are filed into (the effective event folder)
    saveFolder: string | null;
    // Effective file naming mode for this event. Also the season switch: the
    // How match files are named; nothing else.
    fileNameMode: FileNameMode;
    // In-season or off-season, detected (official event = in-season, no event
    // = in-season January to April): gates the off-season-only features
    // (YouTube uploader and Upload tab when opted in, custom display,
    // dead-time cutting).
    season: 'in-season' | 'off-season';
    // The YouTube uploader and Upload tab are in use: FRC off-season with
    // match video upload on in Settings.
    uploader: boolean;
    // True when the event itself sets the mode (official = in-season,
    // unofficial = off-season), so the stored fallback setting does nothing.
    fileNameModeForced: boolean;
    // Example output filename for the current event + naming mode
    sampleFileName: string;
    // Last human-readable status line (mirrors the footer)
    lastMessage: string | null;
}
