import { FileNameMode } from '../utils/recording';

// Snapshot of AutoAV's health, surfaced in the Auto AV tab so a volunteer can
// tell at a glance whether recording is actually working.
export interface AutoAVStatus {
    // Connected to the FMS SignalR hub
    fmsConnected: boolean;
    // vMix reachability + whether it is currently recording
    vmix: { reachable: boolean; recording: boolean };
    // Whether AutoAV itself kicked off the current recording
    recordingActive: boolean;
    // The event AutoAV detected as currently running
    currentEvent: { name: string; code: string | null } | null;
    // Folder the most recent match was saved into (null until first save)
    saveFolder: string | null;
    // Effective file naming mode for this event
    fileNameMode: FileNameMode;
    // Last human-readable status line (mirrors the footer)
    lastMessage: string | null;
}
