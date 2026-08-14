import nodeFetch from 'node-fetch';
import log from 'electron-log';
import { TournamentLevel } from '../models/FMSMatchState';
import { MatchTeam } from '../models/MatchRecord';
import { isDoubleElimFinal } from '../utils/recording';

const FMS_BASE = 'http://10.0.100.5';

export interface MatchResults {
    teams: { red: MatchTeam[]; blue: MatchTeam[] };
    hasCard: boolean;
}

// Shape of the relevant bits of the FMS GetMatchResults* responses. FMS returns
// far more than this; we only read teams + effective card status.
interface FmsTeamResult {
    teamNumber?: number;
    cardEffectiveStatus?: string;
}
interface FmsAllianceData {
    team1?: FmsTeamResult;
    team2?: FmsTeamResult;
    team3?: FmsTeamResult;
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
    return [alliance.team1, alliance.team2, alliance.team3]
        .filter((t): t is FmsTeamResult => !!t && typeof t.teamNumber === 'number')
        .map((t) => ({
            teamNumber: t.teamNumber as number,
            card: normalizeCard(t.cardEffectiveStatus),
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
            return { teams: { red, blue }, hasCard };
        } catch (err) {
            log.warn(`FmsApi: failed to fetch ${endpoint}`, err);
            return null;
        }
    }

    public static get Instance(): FmsApi {
        if (!this.instance) this.instance = new this();
        return this.instance;
    }
}
