import { Entity, Column, Index, ManyToOne } from 'typeorm';
import { S2GameLobby } from './S2GameLobby';
import { S2Profile } from './S2Profile';
import { BnAccount } from './BnAccount';

@Entity()
export class S2GameLobbyTitle {
    @Column({
        primary: true,
        precision: 0,
    })
    date: Date;

    @ManyToOne(type => S2GameLobby, {
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    })
    @Index('lobby_idx')
    lobby: S2GameLobby;

    @Column({
        nullable: false,
        primary: true,
    })
    lobbyId: number;

    @ManyToOne(type => S2Profile, {
        onDelete: 'RESTRICT',
        onUpdate: 'RESTRICT',
    })
    @Index('profile_idx')
    profile: S2Profile;

    @Column({
        nullable: true,
    })
    profileId: number;

    @ManyToOne(type => BnAccount, {
        onDelete: 'RESTRICT',
        onUpdate: 'RESTRICT',
        nullable: true,
    })
    @Index('account_idx')
    account: BnAccount;

    @Column({
        unsigned: true,
        nullable: true,
    })
    accountId: number | null;

    @Column({
        length: 64,
    })
    title: string;

    @Column({
        length: 12,
    })
    hostName: string;
}
