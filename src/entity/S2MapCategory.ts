import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';

@Entity()
export class S2MapCategory {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({
        length: 32,
        nullable: false,
    })
    @Index('code_idx', {
        unique: true,
    })
    code: string;

    @Column({
        length: 64,
        nullable: true,
    })
    name: string;

    @Column({
        nullable: true,
    })
    description: string;

    @Column()
    isMelee: boolean;
}
