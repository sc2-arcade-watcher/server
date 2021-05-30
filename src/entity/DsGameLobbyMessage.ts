import { Entity, PrimaryColumn, ManyToOne, Column, Index } from 'typeorm';
import { S2GameLobby } from './S2GameLobby';
import { DsGameLobbySubscription } from './DsGameLobbySubscription';

@Entity({
    engine: 'ROCKSDB',
})
export class DsGameLobbyMessage {
    @PrimaryColumn({
        type: 'bigint',
    })
    messageId: string | number | BigInt;

    @Column()
    createdAt: Date;

    @Column()
    updatedAt: Date;

    @ManyToOne(type => S2GameLobby, {
        nullable: false,
        onUpdate: 'NO ACTION',
        onDelete: 'NO ACTION',
    })
    @Index('lobby_idx')
    lobby: S2GameLobby;

    @ManyToOne(type => DsGameLobbySubscription, {
        nullable: true,
        onUpdate: 'NO ACTION',
        onDelete: 'NO ACTION',
    })
    subscription?: DsGameLobbySubscription;

    @Column({
        type: 'bigint',
        nullable: true,
    })
    userId: string | number | BigInt;

    @Column({
        type: 'bigint',
        nullable: true,
    })
    guildId: string | number | BigInt;

    @Column({
        type: 'bigint',
        nullable: true,
    })
    channelId: string | number | BigInt;

    @Column()
    closed: boolean;

    @Column()
    completed: boolean;

    get targetId() {
        return this.userId ? String(this.userId) : String(this.guildId);
    }

    get targetChannelId() {
        return this.userId ? String(this.userId) : String(this.channelId);
    }

    get discordId() {
        return this.userId ? `${this.userId}` : `${this.guildId}/${this.channelId}`;
    }

    static create() {
        const gameLobMessage = new DsGameLobbyMessage();
        gameLobMessage.createdAt = new Date();
        gameLobMessage.updatedAt = new Date();
        gameLobMessage.closed = false;
        gameLobMessage.completed = false;
        return gameLobMessage;
    }
}
