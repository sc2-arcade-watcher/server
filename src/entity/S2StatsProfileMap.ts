import { Entity, Column, Index } from 'typeorm';

@Entity()
@Index('map_lob_started_idx', ['mapId', 'regionId', 'lobbiesStarted'])
@Index('map_lob_host_started_idx', ['mapId', 'regionId', 'lobbiesHostedStarted'])
@Index('profile_map_lob_started_idx', ['profileId', 'mapId', 'regionId', 'realmId', 'lobbiesStarted'])
export class S2StatsPlayerMap {
    @Column({
        primary: true,
        type: 'tinyint',
        unsigned: true,
    })
    regionId: number;

    @Column({
        primary: true,
        type: 'mediumint',
        unsigned: true,
    })
    mapId: number;

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

    /** total number of joined lobbies which resulted in a game */
    @Column({
        type: 'mediumint',
        unsigned: true,
    })
    lobbiesStarted: number;

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
        default: 0,
    })
    lastPlayedAt: Date;

    /** stats updated at */
    @Column()
    updatedAt: Date;
}
