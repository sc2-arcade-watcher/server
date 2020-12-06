import { Entity, PrimaryGeneratedColumn, Column, Index, ManyToOne, OneToMany } from 'typeorm';
import { S2Map } from './S2Map';
import { S2Profile } from './S2Profile';
import { S2ProfileMatchMapName } from './S2ProfileMatchMapName';

export enum S2MatchDecision {
    Left = 'left',
    Win = 'win',
    Loss = 'loss',
    Tie = 'tie',
    Observer = 'observer',
    Disagree = 'disagree',
    Unknown = 'unknown',
}

export enum S2MatchSpeed {
    Slower = 'slower',
    Slow = 'slow',
    Normal = 'normal',
    Fast = 'fast',
    Faster = 'faster',
}

export enum S2MatchType {
    Custom = 'custom',
    Unknown = 'unknown',
    Coop = 'coop',
    OneVersusOne = '1v1',
    TwoVersusTwo = '2v2',
    ThreeVersusThree = '3v3',
    FourVersusFour = '4v4',
    FreeForAll = 'ffa',
}

@Entity()
@Index('profile_region_idx', ['profileId', 'regionId'])
@Index('map_region_date_idx', ['mapId', 'regionId', 'date'])
export class S2ProfileMatch {
    @PrimaryGeneratedColumn({
        unsigned: true,
    })
    id: number;

    @Column({
        type: 'tinyint',
        unsigned: true,
    })
    regionId: number;

    @Column({
        type: 'tinyint',
        unsigned: true,
    })
    realmId: number;

    @Column({
        unsigned: true,
    })
    profileId: number;

    @Column({
        precision: 0,
    })
    date: Date;

    @Column({
        type: 'enum',
        enum: S2MatchType,
    })
    type: S2MatchType;

    @Column({
        type: 'enum',
        enum: S2MatchDecision,
    })
    decision: S2MatchDecision;

    @Column({
        type: 'enum',
        enum: S2MatchSpeed,
    })
    speed: S2MatchSpeed;

    @Column({
        type: 'mediumint',
        unsigned: true,
    })
    mapId: number;

    @OneToMany(type => S2ProfileMatchMapName, name => name.match, {
        persistence: false,
        cascade: false,
    })
    names: S2ProfileMatchMapName[];

    map?: S2Map;

    profile?: S2Profile;
}
