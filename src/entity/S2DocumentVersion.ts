import { Entity, PrimaryGeneratedColumn, Column, OneToOne, ManyToOne, Index, Unique } from 'typeorm';
import { S2Document } from './S2Document';

@Entity()
@Unique('document_version', ['document', 'majorVersion', 'minorVersion'])
export class S2DocumentVersion {
    @PrimaryGeneratedColumn()
    id: number;

    @ManyToOne(type => S2Document, document => document.docVersions, {
        nullable: false,
        eager: true,
        onDelete: 'RESTRICT',
        onUpdate: 'RESTRICT',
    })
    @Index()
    document: S2Document;

    @Column({
        type: 'smallint',
        unsigned: true,
    })
    majorVersion: number;

    @Column({
        type: 'smallint',
        unsigned: true,
    })
    minorVersion: number;

    @Column({
        type: 'varchar',
        length: 64,
        nullable: true,
        select: false,
    })
    headerHash: string;

    @Column({
        type: 'varchar',
        length: 64,
        nullable: true,
        select: false,
    })
    documentHash: string;

    @Column({
        type: 'varchar',
        length: 64,
        nullable: true,
    })
    iconHash: string;
}
