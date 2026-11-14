import nodeFetch from 'node-fetch';
import log from 'electron-log';
import { TournamentLevel } from '../models/FMSMatchState';
import { MatchTeam } from '../models/MatchRecord';
import { isDoubleElimFinal } from '../utils/recording';

const FMS_BASE = 'http://10.0.100.5';

export interface MatchResults {
    teams: { red: MatchTeam[]; blue: MatchTeam[] };
    hasCard: boolean;
    // Final alliance totals from scoreDetails; null when FMS didn't report them.
    score: { red: number; blue: number } | null;
}

// Shape of the relevant bits of the FMS GetMatchResults* responses. FMS returns
// far more than this; we only read teams + effective card status.
interface FmsTeamResult {
    teamNumber?: number;
    teamName?: string;
    cardEffectiveStatus?: string;
}
// Qual results put cardEffectiveStatus on each team. Playoff and final results
// put it on the alliance instead, and add a team4 slot (a backup robot; empty
// slots come back with teamNumber 0).
interface FmsAllianceData {
    cardEffectiveStatus?: string;
    // Per-alliance score envelope; totalScore is the final total (game-agnostic).
    scoreDetails?: { totalScore?: number };
    team1?: FmsTeamResult;
    team2?: FmsTeamResult;
    team3?: FmsTeamResult;
    team4?: FmsTeamResult;
}
interface FmsMatchResults {
    redAllianceData?: FmsAllianceData;
    blueAllianceData?: FmsAllianceData;
}

function normalizeCard(status?: string): MatchTeam['card'] {
    if (status === 'Yellow' || status === 'Red') return status;
    return 'None';
}

function mapAlliance(alliance?: FmsAllianceData): MatchTeam[] {
    if (!alliance) return [];
    return [alliance.team1, alliance.team2, alliance.team3, alliance.team4]
        .filter(
            (t): t is FmsTeamResult =>
                !!t && typeof t.teamNumber === 'number' && t.teamNumber > 0
        )
        .map((t) => ({
            teamNumber: t.teamNumber as number,
            // FMS pads some names with spaces (" Dexter Dreadbots ")
            teamName: (t.teamName ?? '').trim() || null,
            card: normalizeCard(
                t.cardEffectiveStatus ?? alliance.cardEffectiveStatus
            ),
        }));
}

// Pick the FMS match-results endpoint for a given level/match number. Practice
// and Match Test have no results endpoint. Returns null when there is nothing
// to fetch.
function resultsEndpoint(
    level: TournamentLevel,
    matchNumber: number
): string | null {
    switch (level) {
        case 'Qualification':
            return `/api/v1.0/audience_gs/get/GetMatchResultsQualData/${matchNumber}`;
        case 'Playoff':
            return isDoubleElimFinal(matchNumber)
                ? `/api/v1.0/audience_gs/get/GetMatchResultsDoubleElimFinalData/${matchNumber}`
                : `/api/v1.0/audience_gs/get/GetMatchResultsDoubleElimPlayoffData/${matchNumber}`;
        default:
            return null;
    }
}

export interface FmsEventInfo {
    eventCode: string;
    eventName: string;
}

export default class FmsApi {
    private static instance: FmsApi;

    /**
     * Fetch the finished-match results (teams + effective card status) for a
     * match. Best-effort: returns null on any error or unsupported level, never
     * throws, so it can safely run after a recording is renamed without risking
     * the file.
     */
    // eslint-disable-next-line class-methods-use-this
    public async getMatchResults(
        level: TournamentLevel,
        matchNumber: number
    ): Promise<MatchResults | null> {
        const endpoint = resultsEndpoint(level, matchNumber);
        if (!endpoint) return null;

        try {
            const resp = await nodeFetch(`${FMS_BASE}${endpoint}`, {
                timeout: 5000,
            });
            if (!resp.ok) {
                log.warn(
                    `FmsApi: ${endpoint} returned ${resp.status} ${resp.statusText}`
                );
                return null;
            }
            const data = (await resp.json()) as FmsMatchResults;
            const red = mapAlliance(data.redAllianceData);
            const blue = mapAlliance(data.blueAllianceData);
            const hasCard = [...red, ...blue].some((t) => t.card !== 'None');
            const redScore = data.redAllianceData?.scoreDetails?.totalScore;
            const blueScore = data.blueAllianceData?.scoreDetails?.totalScore;
            const score =
                typeof redScore === 'number' && typeof blueScore === 'number'
                    ? { red: redScore, blue: blueScore }
                    : null;
            return { teams: { red, blue }, hasCard, score };
        } catch (err) {
            log.warn(`FmsApi: failed to fetch ${endpoint}`, err);
            return null;
        }
    }

    /**
     * The event FMS is currently set up for. Best-effort: null on any error or
     * when FMS has no event code yet.
     */
    // eslint-disable-next-line class-methods-use-this
    public async getEventInfo(): Promise<FmsEventInfo | null> {
        const endpoint = '/api/v1.0/audience/get/GetEventInfo';
        try {
            const resp = await nodeFetch(`${FMS_BASE}${endpoint}`, {
                timeout: 5000,
            });
            if (!resp.ok) return null;
            const data = (await resp.json()) as Partial<FmsEventInfo>;
            const eventCode = (data.eventCode ?? '').trim();
            if (!eventCode) return null;
            return { eventCode, eventName: (data.eventName ?? '').trim() };
        } catch {
            return null;
        }
    }

    public static get Instance(): FmsApi {
        if (!this.instance) this.instance = new this();
        return this.instance;
    }
}
