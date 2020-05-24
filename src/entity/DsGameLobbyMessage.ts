import { Entity, PrimaryGeneratedColumn, ManyToOne, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { S2GameLobby } from './S2GameLobby';
import { DsGameLobbySubscription } from './DsGameLobbySubscription';

@Entity()
export class DsGameLobbyMessage {
    @PrimaryGeneratedColumn()
    id: number;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;

    @ManyToOne(type => S2GameLobby, {
        nullable: false,
        onUpdate: 'RESTRICT',
        onDelete: 'CASCADE',
    })
    lobby: S2GameLobby;

    @ManyToOne(type => DsGameLobbySubscription, {
        nullable: true,
        onUpdate: 'RESTRICT',
        onDelete: 'CASCADE',
    })
    rule?: DsGameLobbySubscription;

    @Column({
        type: 'bigint',
        nullable: true,
    })
    userId: string;

    @Column({
        type: 'bigint',
        nullable: true,
    })
    guildId: string;

    @Column({
        type: 'bigint',
        nullable: true,
    })
    channelId: string;

    @Column({
        type: 'bigint',
    })
    messageId: string;

    @Column({
        default: false,
    })
    completed: boolean;
}
