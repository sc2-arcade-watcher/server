import { Entity, PrimaryColumn, Column, Index } from 'typeorm';

@Entity()
export class S2Region {
    @PrimaryColumn({
        unsigned: true,
        type: 'tinyint',
    })
    id: number;

    @Column({
        type: 'varchar',
        length: 2,
    })
    @Index({
        unique: true,
    })
    code: string;

    @Column({
        length: 32
    })
    name: string;
}
