import { Entity, PrimaryGeneratedColumn, Column, Index, Unique, ManyToOne, OneToMany } from 'typeorm';
import { S2Region } from './S2Region';

@Entity()
@Unique('bnet_id', ['regionId', 'realmId', 'profileId'])
export class S2Profile {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({
        nullable: true,
    })
    @Index()
    updatedAt: Date;

    @ManyToOne(type => S2Region, {
        nullable: false,
        eager: false,
        onDelete: 'RESTRICT',
        onUpdate: 'RESTRICT',
    })
    @Index()
    region: S2Region;

    @Column()
    regionId: number;

    @Column({
        type: 'tinyint',
        unsigned: true,
    })
    realmId: number;

    @Column({
        unsigned: true,
    })
    profileId: number;

    @Column({
        type: 'varchar',
        length: 12,
        nullable: true,
    })
    @Index()
    name: string;

    @Column({
        type: 'mediumint',
        unsigned: true,
        nullable: true,
    })
    discriminator: number;

    @Column({
        default: false,
    })
    deleted: boolean;
}
