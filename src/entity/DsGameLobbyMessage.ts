import { Entity, PrimaryGeneratedColumn, ManyToOne, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { S2GameLobby } from './S2GameLobby';
import { DsGameTrackRule } from './DsGameTrackRule';

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

    @ManyToOne(type => DsGameTrackRule, {
        nullable: false,
        onUpdate: 'RESTRICT',
        onDelete: 'CASCADE',
    })
    rule: DsGameTrackRule;

    @Column({
        type: 'bigint',
        nullable: true,
    })
    owner: string;

    @Column({
        type: 'bigint',
        nullable: true,
    })
    channel: string;

    @Column({
        type: 'bigint',
    })
    message: string;

    @Column({
        default: false,
    })
    completed: boolean;
}
