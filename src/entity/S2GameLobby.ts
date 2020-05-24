import { Entity, PrimaryGeneratedColumn, Column, Index, Unique, ManyToOne, OneToMany } from 'typeorm';
import { S2Region } from './S2Region';
import { S2DocumentVersion } from './S2DocumentVersion';
import { S2Document } from './S2Document';
import { GameLobbyStatus } from '../gametracker';
import { S2GameLobbySlot, S2GameLobbySlotKind } from './S2GameLobbySlot';
import { S2GameLobbyPlayerJoin } from './S2GameLobbyPlayerJoin';

@Entity()
@Unique('bnet_id', ['bnetBucketId', 'bnetRecordId'])
@Index('region_map_status', ['region', 'mapBnetId', 'status'])
export class S2GameLobby {
    @PrimaryGeneratedColumn()
    id: number;

    @ManyToOne(type => S2Region, {
        nullable: false,
        eager: true,
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

    @Column()
    mapVariantMode: string;

    @ManyToOne(type => S2DocumentVersion, {
        nullable: true,
        eager: false,
        onDelete: 'RESTRICT',
        onUpdate: 'RESTRICT',
        persistence: false
    })
    mapDocumentVersion: S2DocumentVersion;

    @ManyToOne(type => S2DocumentVersion, {
        nullable: true,
        eager: false,
        onDelete: 'RESTRICT',
        onUpdate: 'RESTRICT',
        persistence: false
    })
    extModDocumentVersion: S2DocumentVersion;

    @ManyToOne(type => S2DocumentVersion, {
        nullable: true,
        eager: false,
        onDelete: 'RESTRICT',
        onUpdate: 'RESTRICT',
        persistence: false
    })
    multiModDocumentVersion: S2DocumentVersion;

    @Column()
    lobbyTitle: string;

    @Column()
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
    joinInfos: S2GameLobbyPlayerJoin[];

    getSlots(opts: { kinds?: S2GameLobbySlotKind[], teams?: number[] }): S2GameLobbySlot[] {
        return this.slots.filter(slot => {
            if (opts.kinds && !opts.kinds.find(x => x === slot.kind)) return false;
            if (opts.teams && !opts.teams.find(x => x === slot.team)) return false;
            return true;
        });
    }
}
