import * as util from 'util';
import * as fs from 'fs-extra';
import * as orm from 'typeorm';
import { BattleMatchEntryMapper, BattleMatchesSource, BattleMatchMapMapped, BattleMatchMappingResult } from '../../src/bnet/battleData';
import { S2Profile } from '../../src/entity/S2Profile';
import { GameLocale } from '../../src/common';
import { BattleSC2MatchDecision, BattleSC2MatchSpeed, BattleSC2MatchType, BattleSC2MatchEntry } from '../../src/bnet/battleAPI';
import { subHours } from 'date-fns';
import { S2ProfileMatch, S2MatchDecision, S2MatchSpeed, S2MatchType } from '../../src/entity/S2ProfileMatch';
import { deepCopy } from '../../src/helpers';

interface MatchesTestData {
    regionId: number;
    sources: BattleMatchesSource[];
    targetMapIds: number[];
}

function mockupProfile(params: Partial<S2Profile> = {}) {
    const s2profile = S2Profile.create();
    s2profile.name = params?.name ?? 'ASD';
    s2profile.regionId = params?.regionId ?? 1;
    s2profile.realmId = params?.realmId ?? 1;
    s2profile.profileId = params?.profileId ?? 1;
    return s2profile;
}

beforeAll(async () => {
    await orm.createConnection();
});

afterAll(async () => {
    await orm.getConnection().close();
});

describe('BattleMatchEntryMapper', () => {
    test('return newly publised first if the name clashes', async () => {
        const bMapper = new BattleMatchEntryMapper(orm.getConnection());
        const maps = await bMapper.fetchMaps({
            regionId: 2,
            name: 'Lightshade LE',
        });
        expect(maps).toHaveLength(2);
        expect(maps[0].mapId).toBeGreaterThan(maps[1].mapId);
        expect(maps[0].publishedAt.getTime()).toBeGreaterThan(maps[1].updatedAt.getTime());
    });

    test('partial data processing if unknown maps are found', async () => {
        const bMapper = new BattleMatchEntryMapper(orm.getConnection());
        const s2profile = mockupProfile({ regionId: 1 });

        const tnow = new Date();
        tnow.setMilliseconds(0);

        const mostRecentMatch = new S2ProfileMatch();
        mostRecentMatch.regionId = s2profile.regionId;
        mostRecentMatch.profileId = s2profile.profileId;
        mostRecentMatch.realmId = s2profile.realmId;
        mostRecentMatch.mapId = 42; // High Orbit
        mostRecentMatch.date = new Date(((tnow.getTime() / 1000) - 2000) * 1000);
        mostRecentMatch.date.setMilliseconds(0);
        mostRecentMatch.decision = S2MatchDecision.Win;
        mostRecentMatch.speed = S2MatchSpeed.Faster;
        mostRecentMatch.type = S2MatchType.Custom;
        const integritySince = subHours(tnow, 48);

        const matchEntriesEN: BattleSC2MatchEntry[] = [
            {
                date: (tnow.getTime() / 1000) - 500,
                decision: BattleSC2MatchDecision.Win,
                map: 'Agria Valley',
                speed: BattleSC2MatchSpeed.Faster,
                type: BattleSC2MatchType.Custom,
            },
            {
                date: (tnow.getTime() / 1000) - 1000,
                decision: BattleSC2MatchDecision.Win,
                map: 'UNKNOWN MAP Rn3i2obn32ob23---',
                speed: BattleSC2MatchSpeed.Faster,
                type: BattleSC2MatchType.Custom,
            },
            {
                date: (tnow.getTime() / 1000) - 1500,
                decision: BattleSC2MatchDecision.Observer,
                map: 'Agria Valley',
                speed: BattleSC2MatchSpeed.Faster,
                type: BattleSC2MatchType.Custom,
            },
            {
                date: (tnow.getTime() / 1000) - 1700,
                decision: BattleSC2MatchDecision.Win,
                map: 'Crossfire',
                speed: BattleSC2MatchSpeed.Faster,
                type: BattleSC2MatchType.Custom,
            },
            {
                date: mostRecentMatch.date.getTime() / 1000,
                decision: BattleSC2MatchDecision.Left,
                map: 'High Orbit',
                speed: BattleSC2MatchSpeed.Faster,
                type: BattleSC2MatchType.Custom,
            },
            {
                date: mostRecentMatch.date.getTime() / 1000,
                decision: BattleSC2MatchDecision.Left,
                map: 'High Orbit',
                speed: BattleSC2MatchSpeed.Faster,
                type: BattleSC2MatchType.Custom,
            },
        ];
        const macthEntriesPL = deepCopy(matchEntriesEN);
        macthEntriesPL[0].map = '';
        macthEntriesPL[2].map = 'Dolina Agrii';
        macthEntriesPL[3].map = 'Krzyżowy ogień';
        macthEntriesPL[4].map = 'Wysoka orbita';
        macthEntriesPL[5].map = 'Wysoka orbita';

        const mappedResultIncomplete = (await bMapper.mapFromSource(
            [
                {
                    locale: GameLocale.enUS,
                    entries: matchEntriesEN,
                },
            ],
            s2profile,
            mostRecentMatch,
            integritySince
        )) as BattleMatchMappingResult;
        expect(mappedResultIncomplete).toBeFalsy();

        const mappedResult = (await bMapper.mapFromSource(
            [
                {
                    locale: GameLocale.enUS,
                    entries: matchEntriesEN,
                },
                {
                    locale: GameLocale.plPL,
                    entries: matchEntriesEN,
                },
            ],
            s2profile,
            mostRecentMatch,
            integritySince
        )) as BattleMatchMappingResult;

        expect(typeof mappedResult === 'object').toBeTruthy();
        expect(mappedResult.matches).toHaveLength(2);
        expect(mappedResult.matches.map(x => x.mapId)).toEqual([26, 23]);
        expect(mappedResult.integritySince.getTime()).toEqual(integritySince.getTime());
    });

    test('maintain integrity', async () => {
        const bMapper = new BattleMatchEntryMapper(orm.getConnection());
        const s2profile = mockupProfile({ regionId: 1 });

        const tnow = new Date();
        tnow.setMilliseconds(0);

        const mostRecentMatch = new S2ProfileMatch();
        mostRecentMatch.regionId = s2profile.regionId;
        mostRecentMatch.profileId = s2profile.profileId;
        mostRecentMatch.realmId = s2profile.realmId;
        mostRecentMatch.mapId = 42; // High Orbit
        mostRecentMatch.date = new Date(tnow.getTime() - 600 * 1000);
        mostRecentMatch.decision = S2MatchDecision.Win;
        mostRecentMatch.speed = S2MatchSpeed.Faster;
        mostRecentMatch.type = S2MatchType.Custom;
        const integritySince = subHours(tnow, 48);

        const mappedResult = (await bMapper.mapFromSource(
            [
                {
                    locale: GameLocale.enUS,
                    entries: [
                        {
                            date: (tnow.getTime() / 1000),
                            decision: BattleSC2MatchDecision.Win,
                            map: 'Agria Valley',
                            speed: BattleSC2MatchSpeed.Faster,
                            type: BattleSC2MatchType.Custom,
                        },
                        {
                            date: (mostRecentMatch.date.getTime() / 1000),
                            decision: BattleSC2MatchDecision.Win,
                            map: 'High Orbit',
                            speed: BattleSC2MatchSpeed.Faster,
                            type: BattleSC2MatchType.Custom,
                        },
                        {
                            date: (mostRecentMatch.date.getTime() / 1000) - 3600,
                            decision: BattleSC2MatchDecision.Win,
                            map: 'High Orbit',
                            speed: BattleSC2MatchSpeed.Faster,
                            type: BattleSC2MatchType.Custom,
                        },
                    ],
                }
            ],
            s2profile,
            mostRecentMatch,
            integritySince
        )) as BattleMatchMappingResult;

        expect(typeof mappedResult === 'object').toBeTruthy();
        expect(mappedResult.matches).toHaveLength(1);
        expect(mappedResult.integritySince.getTime()).toEqual(integritySince.getTime());
    });

    test('invalidate integrity', async () => {
        const bMapper = new BattleMatchEntryMapper(orm.getConnection());
        const s2profile = mockupProfile({ regionId: 1 });

        const tnow = new Date();
        tnow.setMilliseconds(0);

        const mostRecentMatch = new S2ProfileMatch();
        mostRecentMatch.regionId = s2profile.regionId;
        mostRecentMatch.profileId = s2profile.profileId;
        mostRecentMatch.realmId = s2profile.realmId;
        mostRecentMatch.mapId = 42; // High Orbit
        mostRecentMatch.date = new Date(tnow.getTime() - 2000 * 1000);
        mostRecentMatch.decision = S2MatchDecision.Win;
        mostRecentMatch.speed = S2MatchSpeed.Faster;
        mostRecentMatch.type = S2MatchType.Custom;
        const integritySince = subHours(tnow, 48);

        const mappedResult = (await bMapper.mapFromSource(
            [
                {
                    locale: GameLocale.enUS,
                    entries: [
                        {
                            date: (tnow.getTime() / 1000) - 500,
                            decision: BattleSC2MatchDecision.Win,
                            map: 'High Orbit',
                            speed: BattleSC2MatchSpeed.Faster,
                            type: BattleSC2MatchType.Custom,
                        },
                    ],
                }
            ],
            s2profile,
            mostRecentMatch,
            integritySince
        )) as BattleMatchMappingResult;

        expect(typeof mappedResult === 'object').toBeTruthy();
        expect(mappedResult.integritySince.getTime()).toEqual(mappedResult.matches[0].date * 1000);
    });

    const fixturesPath = `tests/fixtures/match-history`;
    const testDataFiles = fs.readdirSync(fixturesPath, 'utf8').filter(x => x.endsWith('.json'));
    for (const fName of testDataFiles) {
        test(fName, async () => {
            const bMapper = new BattleMatchEntryMapper(orm.getConnection());
            const matchesData: MatchesTestData = await fs.readJSON(`${fixturesPath}/${fName}`);
            const s2profile = mockupProfile({ regionId: matchesData.regionId });

            const mappedResult = await bMapper.mapFromSource(matchesData.sources, s2profile, void 0, void 0, matchesData.sources.length);
            expect(typeof mappedResult === 'object').toBeTruthy();
            if (typeof mappedResult === 'object') {
                expect(mappedResult.matches).toHaveLength(matchesData.sources[0].entries.length);

                const receivedMapIds = mappedResult.matches.map(x => x.mapId).reverse();
                expect(receivedMapIds).toEqual(matchesData.targetMapIds);
            }
        });
    }
});
