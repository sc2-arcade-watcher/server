import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, Index, Unique } from 'typeorm';
import { S2GameLobby } from './S2GameLobby';
import { S2Profile } from './S2Profile';

@Entity()
@Index('lobby_player', ['lobby', 'profile'])
export class S2GameLobbyPlayerJoin {
    @PrimaryGeneratedColumn()
    id: number;

    @ManyToOne(type => S2GameLobby, {
        onDelete: 'RESTRICT',
        onUpdate: 'RESTRICT',
    })
    @Index('lobby')
    lobby: S2GameLobby;

    @ManyToOne(type => S2Profile, {
        onDelete: 'RESTRICT',
        onUpdate: 'RESTRICT',
    })
    @Index('profile')
    profile: S2Profile;

    @Column({
        nullable: false,
    })
    joinedAt: Date;

    @Column({
        nullable: true,
    })
    leftAt: Date;
}
