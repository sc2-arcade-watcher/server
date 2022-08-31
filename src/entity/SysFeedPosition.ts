import { Entity, Column, OneToOne, JoinColumn } from 'typeorm';
import { SysFeedProvider } from './SysFeedProvider';

@Entity({
    engine: 'ROCKSDB',
})
export class SysFeedPosition {
    @OneToOne(type => SysFeedProvider, {
        nullable: false,
        onDelete: 'RESTRICT',
        onUpdate: 'RESTRICT',
        primary: true,
    })
    @JoinColumn()
    provider: SysFeedProvider;

    @Column({
        default: 0,
    })
    resumingFile: number;

    @Column({
        default: 0,
    })
    resumingOffset: number;

    @Column({
        default: 0,
    })
    storageFile: number;

    @Column({
        default: 0,
    })
    storageOffset: number;
}
