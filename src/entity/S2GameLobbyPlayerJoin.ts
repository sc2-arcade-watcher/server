import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, Index, Unique } from 'typeorm';
import { S2GameLobby } from './S2GameLobby';
import { S2Profile } from './S2Profile';

@Entity()
export class S2GameLobbyPlayerJoin {
    @PrimaryGeneratedColumn()
    id: number;

    @ManyToOne(type => S2GameLobby, lobby => lobby.joinHistory, {
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    })
    @Index('lobby_idx')
    lobby: S2GameLobby;

    @ManyToOne(type => S2Profile, {
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    })
    @Index('profile_idx')
    profile: S2Profile;

    @Column({
        nullable: true,
    })
    profileId: number;

    @Column({
        nullable: false,
        precision: 3,
    })
    joinedAt: Date;

    @Column({
        nullable: true,
        precision: 3,
    })
    leftAt: Date;
}
