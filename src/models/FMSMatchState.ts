// Match State
type MatchState = 
"WaitingForSetAudience" | 
"WaitingForMatchReady" | 
"WaitingForMatchStart" | 
"GameSpecificData" | 
"MatchAuto" | 
"MatchTransition" | 
"MatchTeleop" | 
"WaitingForCommit" | 
"WaitingForPostResults" | 
"WaitingForPrestart";

// P1: Match State (String), P2: Match Number (Number), P3: Play Number (Number), P4: Level (String)
type FMSMatchStatus = { 
    MatchState: MatchState; 
    MatchNumber: number;
    PlayNumber: number; 
    Level: string 
};

export default FMSMatchStatus;
