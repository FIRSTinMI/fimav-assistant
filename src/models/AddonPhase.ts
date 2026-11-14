// Where a downloaded add-on (Live Captions, YouTube uploader, audience
// display) is: checking for / downloading an update, launched and waiting
// for its server, serving, or stopped.
export type AddonPhase = 'stopped' | 'updating' | 'starting' | 'running';

export const ADDON_PHASE_LABEL: Record<AddonPhase, string> = {
    stopped: 'Stopped',
    updating: 'Updating',
    starting: 'Starting',
    running: 'Running',
};
