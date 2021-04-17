import { Entity, PrimaryGeneratedColumn, Column, Index, ManyToOne, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { S2Region } from './S2Region';

@Entity()
export class DsGameLobbySubscription {
    @PrimaryGeneratedColumn()
    id: number;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;

    @Column({
        default: true,
    })
    enabled: boolean;

    @Column({
        type: 'bigint',
        nullable: true,
    })
    userId: string | BigInt;

    @Column({
        type: 'bigint',
        nullable: true,
    })
    guildId: string | BigInt;

    @Column({
        type: 'bigint',
        nullable: true,
    })
    channelId: string | BigInt;

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
}
