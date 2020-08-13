import { Entity, PrimaryGeneratedColumn, Column, Index, Unique, ManyToOne, OneToMany } from 'typeorm';
import { S2Region } from './S2Region';
import { GameLobbyStatus } from '../gametracker';
import { S2GameLobbySlot, S2GameLobbySlotKind } from './S2GameLobbySlot';
import { S2GameLobbyPlayerJoin } from './S2GameLobbyPlayerJoin';
import { S2Map } from './S2Map';

@Entity()
@Unique('bnet_id', ['bnetBucketId', 'bnetRecordId'])
@Index('region_map_status', ['region', 'mapBnetId', 'status'])
export class S2GameLobby {
    @PrimaryGeneratedColumn()
    id: number;

    @ManyToOne(type => S2Region, {
        nullable: false,
        onDelete: 'RESTRICT',
        onUpdate: 'RESTRICT',
    })
    @Index()
    region: S2Region;

    @Column()
    regionId: number;

    @Column()
    bnetBucketId: number;

    @Column()
    bnetRecordId: number;

    @Column({
        precision: 3,
    })
    createdAt: Date;

    @Column({
        nullable: true,
        precision: 3,
    })
    @Index()
    closedAt: Date;

    @Column({
        precision: 3,
    })
    snapshotUpdatedAt: Date;

    @Column({
        nullable: true,
        precision: 3,
    })
    slotsUpdatedAt: Date;

    @Column({
        type: 'enum',
        enum: GameLobbyStatus,
        default: GameLobbyStatus.Open,
    })
    @Index()
    status: GameLobbyStatus;

    @Column({
        type: 'mediumint',
        unsigned: true,
    })
    mapBnetId: number;

    @Column({
        type: 'smallint',
        unsigned: true,
    })
    mapMajorVersion: number;

    @Column({
        type: 'smallint',
        unsigned: true,
    })
    mapMinorVersion: number;

    @Column({
        type: 'mediumint',
        unsigned: true,
        nullable: true,
    })
    extModBnetId: number;

    @Column({
        type: 'smallint',
        unsigned: true,
        nullable: true,
    })
    extModMajorVersion: number;

    @Column({
        type: 'smallint',
        unsigned: true,
        nullable: true,
    })
    extModMinorVersion: number;

    @Column({
        type: 'mediumint',
        unsigned: true,
        nullable: true,
    })
    multiModBnetId: number;

    @Column({
        type: 'smallint',
        unsigned: true,
        nullable: true,
    })
    multiModMajorVersion: number;

    @Column({
        type: 'smallint',
        unsigned: true,
        nullable: true,
    })
    multiModMinorVersion: number;

    @Column({
        type: 'tinyint',
        unsigned: true,
    })
    mapVariantIndex: number;

    @Column({
        length: 80,
    })
    mapVariantMode: string;

    @Column({
        length: 80,
        // length: 64,
        // 64 is probably actual correct limit?
    })
    lobbyTitle: string;

    @Column({
        length: 12,
    })
    hostName: string;

    @Column({
        type: 'tinyint',
        unsigned: true,
    })
    slotsHumansTotal: number;

    @Column({
        type: 'tinyint',
        unsigned: true,
    })
    slotsHumansTaken: number;

    @OneToMany(type => S2GameLobbySlot, slot => slot.lobby, {
        persistence: false
    })
    slots: S2GameLobbySlot[];

    @OneToMany(type => S2GameLobbyPlayerJoin, joinInfo => joinInfo.lobby, {
        cascade: false,
    })
    joinHistory: S2GameLobbyPlayerJoin[];

    map?: S2Map;
    extMod?: S2Map;
    multimod?: S2Map;

    getSlots(opts: { kinds?: S2GameLobbySlotKind[], teams?: number[] }): S2GameLobbySlot[] {
        return this.slots.filter(slot => {
            if (opts.kinds && !opts.kinds.find(x => x === slot.kind)) return false;
            if (opts.teams && !opts.teams.find(x => x === slot.team)) return false;
            return true;
        });
    }

    getLeavers() {
        return this.joinHistory.filter(x => x.leftAt !== null).sort((a, b) => a.leftAt.getTime() - b.leftAt.getTime());
    }
}
