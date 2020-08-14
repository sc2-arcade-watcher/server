import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, Index, Unique } from 'typeorm';
import { S2GameLobby } from './S2GameLobby';
import { S2Profile } from './S2Profile';
import { S2GameLobbyPlayerJoin } from './S2GameLobbyPlayerJoin';

export enum S2GameLobbySlotKind {
    Open = 'open',
    AI = 'ai',
    Human = 'human',
}

@Entity()
export class S2GameLobbySlot {
    @PrimaryGeneratedColumn()
    id: number;

    @ManyToOne(type => S2GameLobby, lobby => lobby.slots, {
        onDelete: 'RESTRICT',
        onUpdate: 'RESTRICT',
    })
    @Index('lobby')
    lobby: S2GameLobby;

    @Column()
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
        onDelete: 'RESTRICT',
        onUpdate: 'RESTRICT',
    })
    @Index('profile')
    profile: S2Profile;

    @ManyToOne(type => S2GameLobbyPlayerJoin, {
        nullable: true,
        onDelete: 'RESTRICT',
        onUpdate: 'RESTRICT',
    })
    joinInfo: S2GameLobbyPlayerJoin;

    @Column({
        type: 'varchar',
        length: 12,
        nullable: true,
    })
    name: string;

    get slotKindPriority(): number {
        const slotKindMap = {
            [S2GameLobbySlotKind.Open]: 1,
            [S2GameLobbySlotKind.AI]: 2,
            [S2GameLobbySlotKind.Human]: 3,
        };
        return slotKindMap[this.kind];
    }
}
