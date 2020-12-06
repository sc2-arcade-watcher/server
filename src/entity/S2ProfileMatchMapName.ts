import { Entity, PrimaryGeneratedColumn, Column, Index, ManyToOne } from 'typeorm';
import { S2ProfileMatch } from './S2ProfileMatch';
import { GameLocale } from '../common';

@Entity()
export class S2ProfileMatchMapName {
    @PrimaryGeneratedColumn({
        unsigned: true,
    })
    id: number;

    @ManyToOne(type => S2ProfileMatch, match => match.names, {
        nullable: false,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    })
    @Index('match_idx')
    match: S2ProfileMatch;

    @Column({
        type: 'enum',
        enum: GameLocale,
        primary: true,
    })
    locale: GameLocale;

    @Column()
    name: string;
}
