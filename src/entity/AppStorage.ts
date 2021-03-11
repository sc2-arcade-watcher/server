import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';

@Entity({
    engine: 'ROCKSDB',
})
export class AppStorage {
    @PrimaryGeneratedColumn({
        unsigned: true,
    })
    id: number;

    @Column({
        type: 'varchar',
        collation: 'ascii_bin',
        nullable: false,
    })
    @Index('key_idx', {
        unique: true,
    })
    key: string;

    @Column({
        type: 'text',
        nullable: false,
    })
    value: string;
}
