import { Entity, Column } from 'typeorm';

@Entity()
export class S2StatsPlayerStatus {
    @Column({
        primary: true,
        type: 'tinyint',
        unsigned: true,
    })
    regionId: number;

    @Column({
        default: '0000-00-00 00:00:00',
    })
    updatedAt: Date;
}
