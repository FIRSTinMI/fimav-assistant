// Match State
type MatchState =
    | 'NoCurrentlyActiveEvent'
    | 'NoCurrentlyActiveTournamentLevel'
    | 'WaitingForPrestart'
    | 'WaitingForPrestartTO'
    | 'Prestarting'
    | 'PrestartingTO'
    | 'WaitingForSetAudience'
    | 'WaitingForSetAudienceTO'
    | 'WaitingForMatchReady'
    | 'WaitingForMatchStart'
    | 'GameSpecificData'
    | 'MatchAuto'
    | 'MatchTransition'
    | 'MatchTeleop'
    | 'WaitingForCommit'
    | 'WaitingForPostResults'
    | 'TournamentLevelComplete'
    | 'MatchCancelled'
    | 'WaitingForMatchPreview'
    | 'WaitingForMatchPreviewTO';

type TournamentLevel = 'Practice' | 'Qualification' | 'Playoff' | 'Match Test';

// P1: Match State (String), P2: Match Number (Number), P3: Play Number (Number), P4: Level (String)
type FMSMatchStatus = {
    MatchState: MatchState;
    MatchNumber: number;
    PlayNumber: number;
    Level: TournamentLevel;
};

export default FMSMatchStatus;
