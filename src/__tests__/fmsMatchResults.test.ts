import nodeFetch from 'node-fetch';
import FmsApi from '../services/FmsApi';

jest.mock('electron-log', () => ({ warn: jest.fn() }));
jest.mock('node-fetch', () => jest.fn());

const respond = (body: unknown) =>
    (nodeFetch as unknown as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => body,
    });

describe('FMS match results', () => {
    it('reads per-team cards and names in quals', async () => {
        respond({
            redAllianceData: {
                team1: {
                    teamNumber: 33,
                    teamName: 'Killer Bees',
                    cardEffectiveStatus: 'Yellow',
                },
                team2: {
                    teamNumber: 67,
                    teamName: 'HOT',
                    cardEffectiveStatus: 'None',
                },
                team3: {
                    teamNumber: 469,
                    teamName: 'Las Guerrillas',
                    cardEffectiveStatus: 'None',
                },
            },
            blueAllianceData: {},
        });
        const r = await FmsApi.Instance.getMatchResults('Qualification', 1);
        expect(r?.teams.red[0]).toEqual({
            teamNumber: 33,
            teamName: 'Killer Bees',
            card: 'Yellow',
        });
        expect(r?.hasCard).toBe(true);
    });

    it('applies the alliance card in playoffs, adds team4, skips empty slots', async () => {
        respond({
            redAllianceData: {
                cardEffectiveStatus: 'Red',
                team1: { teamNumber: 7197, teamName: 'Mountie Megabots' },
                team2: { teamNumber: 3656, teamName: ' Dexter Dreadbots ' },
                team3: { teamNumber: 4327, teamName: 'Q Branch' },
                team4: { teamNumber: 2337, teamName: 'EngiNERDs' },
            },
            blueAllianceData: {
                cardEffectiveStatus: 'None',
                team1: { teamNumber: 1, teamName: 'A' },
                team2: { teamNumber: 2, teamName: 'B' },
                team3: { teamNumber: 3, teamName: 'C' },
                team4: { teamNumber: 0, teamName: null },
            },
        });
        const r = await FmsApi.Instance.getMatchResults('Playoff', 1);
        expect(r?.teams.red).toHaveLength(4);
        expect(r?.teams.red.every((t) => t.card === 'Red')).toBe(true);
        expect(r?.teams.red[1].teamName).toBe('Dexter Dreadbots');
        expect(r?.teams.blue).toHaveLength(3);
        expect(r?.teams.blue[0].teamName).toBe('A');
        expect(r?.hasCard).toBe(true);
    });
});
