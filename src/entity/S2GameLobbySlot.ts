import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, Index, Unique, JoinColumn } from 'typeorm';
import { S2GameLobby } from './S2GameLobby';
import { S2Profile } from './S2Profile';
import { S2GameLobbyPlayerJoin } from './S2GameLobbyPlayerJoin';

export enum S2GameLobbySlotKind {
    Open = 'open',
    AI = 'ai',
    Human = 'human',
}

const slotKindMap = {
    [S2GameLobbySlotKind.Open]: 1,
    [S2GameLobbySlotKind.AI]: 2,
    [S2GameLobbySlotKind.Human]: 3,
};

@Entity({
    engine: 'ROCKSDB',
})
export class S2GameLobbySlot {
    @PrimaryGeneratedColumn()
    id: number;

    @ManyToOne(type => S2GameLobby, lobby => lobby.slots, {
        primary: true,
        nullable: false,
        // foreign keys not supported on RocksDB
        onDelete: 'NO ACTION',
        onUpdate: 'NO ACTION',
    })
    @JoinColumn()
    // probably not needed due to lobbyId being first part of PK (and the only part)
    // @Index('lobby_idx', { unique: true })
    lobby: S2GameLobby;

    @Column({
        primary: true,
        type: 'int',
        unsigned: true,
    })
    lobbyId: number;

    @Column({
        type: 'tinyint',
        unsigned: true,
    })
    slotNumber: number;

    @Column({
        type: 'tinyint',
        unsigned: true,
    })
    team: number;

    @Column({
        type: 'enum',
        nullable: true,
        enum: S2GameLobbySlotKind,
    })
    kind: S2GameLobbySlotKind;

    @ManyToOne(type => S2Profile, {
        nullable: true,
        // foreign keys not supported on RocksDB
        onDelete: 'NO ACTION',
        onUpdate: 'NO ACTION',
    })
    @Index('profile_idx')
    profile: S2Profile;

    @Column({
        nullable: true,
    })
    profileId: number;

    @ManyToOne(type => S2GameLobbyPlayerJoin, {
        nullable: true,
        // foreign keys not supported on RocksDB
        onDelete: 'NO ACTION',
        onUpdate: 'NO ACTION',
    })
    joinInfo: S2GameLobbyPlayerJoin;

    @Column({
        nullable: true,
    })
    joinInfoId: number | null;

    @Column({
        type: 'varchar',
        length: 12,
        nullable: true,
    })
    name: string;

    get slotKindPriority(): number {
        return slotKindMap[this.kind];
    }
}
