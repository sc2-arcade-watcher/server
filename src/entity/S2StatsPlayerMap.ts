import { Entity, Column, Index } from 'typeorm';
import { S2Map } from './S2Map';
import { S2Profile } from './S2Profile';

@Entity()
@Index('map_lob_started_idx', ['mapId', 'regionId', 'lobbiesStarted'])
@Index('map_lob_host_started_idx', ['mapId', 'regionId', 'lobbiesHostedStarted'])
export class S2StatsPlayerMap {
    @Column({
        primary: true,
        type: 'tinyint',
        unsigned: true,
    })
    regionId: number;

    @Column({
        primary: true,
        type: 'tinyint',
        unsigned: true,
    })
    realmId: number;

    @Column({
        primary: true,
        unsigned: true,
    })
    profileId: number;

    @Column({
        primary: true,
        type: 'mediumint',
        unsigned: true,
    })
    mapId: number;

    /** total number of joined lobbies which resulted in a game */
    @Column({
        type: 'mediumint',
        unsigned: true,
    })
    lobbiesStarted: number;

    /** total number of joined lobbies which resulted in a game, constrained to at most 1 within period of a day */
    @Column({
        type: 'mediumint',
        unsigned: true,
    })
    lobbiesStartedDiffDays: number;

    /** total number of different lobbies joined */
    @Column({
        type: 'mediumint',
        unsigned: true,
    })
    lobbiesJoined: number;

    /** total number of hosted lobbies */
    @Column({
        type: 'mediumint',
        unsigned: true,
    })
    lobbiesHosted: number;

    /** total number of hosted lobbies which resulted in a game */
    @Column({
        type: 'mediumint',
        unsigned: true,
    })
    lobbiesHostedStarted: number;

    /** time (in secs) spent waiting in lobbies */
    @Column({
        unsigned: true,
    })
    timeSpentWaiting: number;

    /** time (in secs) spent waiting in self-hosted lobbies */
    @Column({
        unsigned: true,
    })
    timeSpentWaitingAsHost: number;

    /** last time seen in started lobby */
    @Column({
        default: '0000-00-00 00:00:00',
    })
    lastPlayedAt: Date;

    map?: S2Map;

    profile?: S2Profile;

    static create(params: Partial<S2StatsPlayerMap> = {}) {
        const defaults: Partial<S2StatsPlayerMap> = {
            lobbiesStarted: 0,
            lobbiesStartedDiffDays: 0,
            lobbiesJoined: 0,
            lobbiesHosted: 0,
            lobbiesHostedStarted: 0,
            timeSpentWaiting: 0,
            timeSpentWaitingAsHost: 0,
            lastPlayedAt: new Date(0),
        };
        return Object.assign(new S2StatsPlayerMap(), defaults, params);
    }
}
