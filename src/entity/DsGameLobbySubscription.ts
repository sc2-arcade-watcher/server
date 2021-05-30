import { Entity, PrimaryGeneratedColumn, Column, Index, ManyToOne, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { S2Region } from './S2Region';

@Entity({
    engine: 'ROCKSDB',
})
export class DsGameLobbySubscription {
    @PrimaryGeneratedColumn()
    id: number;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;

    @Column({
        nullable: true,
    })
    @Index('deleted_at_idx')
    deletedAt: Date;

    @Column({
        default: true,
    })
    enabled: boolean;

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
    mapName: string;

    @Column({
        default: false,
    })
    isMapNamePartial: boolean;

    @Column({
        default: false,
    })
    isMapNameRegex: boolean;

    @Column({
        nullable: true,
        unsigned: true,
        type: 'tinyint',
    })
    regionId: number | null;

    @Column({
        nullable: true,
    })
    variant: string;

    @Column({
        type: 'smallint',
        unsigned: true,
        default: 0,
    })
    timeDelay: number;

    @Column({
        type: 'tinyint',
        unsigned: true,
        default: 0,
    })
    humanSlotsMin: number;

    @Column({
        default: false,
    })
    showLeavers: boolean;

    @Column({
        default: false,
    })
    deleteMessageStarted: boolean;

    @Column({
        default: false,
    })
    deleteMessageAbandoned: boolean;

    @Column({
        default: false,
    })
    postMatchResult: boolean;

    get targetId() {
        return this.userId ? String(this.userId) : String(this.guildId);
    }

    get targetChannelId() {
        return this.userId ? String(this.userId) : String(this.channelId);
    }

    get discordId() {
        return this.userId ? `${this.userId}` : `${this.guildId}/${this.channelId}`;
    }
}
