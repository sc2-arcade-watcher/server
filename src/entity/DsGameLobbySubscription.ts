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

    @ManyToOne(type => S2Region, {
        nullable: true,
        onDelete: 'RESTRICT',
        onUpdate: 'RESTRICT',
    })
    region: S2Region;

    @Column({
        nullable: true,
    })
    variant: string;

    @Column({
        type: 'smallint',
        unsigned: true,
        nullable: true,
    })
    timeDelay: number;

    @Column({
        type: 'tinyint',
        unsigned: true,
        nullable: true,
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
    deleteMessageDisbanded: boolean;
}
