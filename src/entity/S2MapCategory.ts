import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';

@Entity()
export class S2MapCategory {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({
        length: 64,
        nullable: false,
    })
    @Index('category_name', {
        unique: true,
    })
    name: string;

    @Column({
        nullable: true,
    })
    description: string;
}
