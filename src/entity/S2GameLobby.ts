import { Entity, PrimaryGeneratedColumn, Column, Index, Unique, ManyToOne, OneToMany, OneToOne } from 'typeorm';
import { S2Region } from './S2Region';
import { S2GameLobbySlot, S2GameLobbySlotKind } from './S2GameLobbySlot';
import { S2GameLobbyPlayerJoin } from './S2GameLobbyPlayerJoin';
import { S2Map } from './S2Map';
import { S2GameLobbyTitle } from './S2GameLobbyTitle';
import { GameRegion, GameLobbyStatus } from '../common';
import { S2LobbyMatch } from './S2LobbyMatch';
import { S2GameLobbyMap } from './S2GameLobbyMap';

@Entity({
    engine: 'ROCKSDB',
})
@Unique('bnet_id', ['bnetBucketId', 'bnetRecordId'])
export class S2GameLobby {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({
        unsigned: true,
        type: 'tinyint',
    })
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
    })
    @Index()
    status: GameLobbyStatus;

    @Column({
        type: 'mediumint',
        unsigned: true,
    })
    mapBnetId: number;

    @Column({
        type: 'mediumint',
        unsigned: true,
        nullable: true,
    })
    extModBnetId: number;

    @Column({
        type: 'mediumint',
        unsigned: true,
        nullable: true,
    })
    multiModBnetId: number;

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
        persistence: false,
    })
    joinHistory: S2GameLobbyPlayerJoin[];

    @OneToMany(type => S2GameLobbyMap, x => x.lobby, {
        cascade: false,
        persistence: false,
    })
    maps: S2GameLobbyMap[];

    @OneToMany(type => S2GameLobbyTitle, title => title.lobby, {
        cascade: false,
        persistence: false,
    })
    titleHistory: S2GameLobbyTitle[];

    @OneToOne(type => S2LobbyMatch, x => x.lobby, {
        cascade: false,
        persistence: false,
    })
    match: S2LobbyMatch;

    map?: S2Map;
    extMod?: S2Map;
    multiMod?: S2Map;

    get globalId() {
        return `${this.regionId}/${this.bnetBucketId}/${this.bnetRecordId}`;
    }

    get globalNameId() {
        return `${GameRegion[this.regionId]}#${this.bnetBucketId}/${this.bnetRecordId}`;
    }

    get sumSlots() {
        const slInfo = {
            total: this.slots.length,
            taken: 0,
            open: 0,
            human: 0,
            ai: 0,
        };
        this.slots.forEach(slot => {
            switch (slot.kind) {
                case S2GameLobbySlotKind.Open: {
                    ++slInfo.open;
                    break;
                }
                case S2GameLobbySlotKind.AI: {
                    ++slInfo.ai;
                    break;
                }
                case S2GameLobbySlotKind.Human: {
                    ++slInfo.human;
                    break;
                }
            }
        });
        slInfo.taken = slInfo.human + slInfo.ai;
        return slInfo;
    }

    get statSlots() {
        const tmp = this.sumSlots;
        return `[${tmp.taken}/${tmp.taken + tmp.open}]`;
    }

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
